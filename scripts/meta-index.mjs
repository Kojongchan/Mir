// Object tree and property shards from an SVF property database (objects_*.json.gz), for the self-hosted
// viewer's model tree, property panel and name search. Pure: arrays in, plain objects out.
//
// Property DB layout (dbId = object id, 1-based): offs[dbId] → first attribute/value pair in avs
// (pairs of [attrIndex, valueIndex]); attrs[i] = [name, category, dataType, dataTypeContext, description,
// displayName, flags, displayPrecision]; internal categories look like "__parent__", "__name__".

const INTERNAL = /^__\w+__$/;
const HIDDEN_FLAG = 1;

/** Readable unit from an attribute's dataTypeContext ("autodesk.unit.unit:meters-1.0.0" → "meters"). */
function unitOf(context) {
  if (typeof context !== 'string' || !context) return '';
  const m = /unit:([a-zA-Z]+)/.exec(context);
  if (m) return m[1];
  return context.length <= 8 ? context : '';
}

function cleanValue(v) {
  if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) return Math.round(v * 1e6) / 1e6;
  return v;
}

export function buildMetaIndex({ ids, offs, avs, attrs, vals }, { shardSize = 1024 } = {}) {
  const n = offs.length;
  const parent = new Array(n).fill(0);
  const name = new Array(n).fill('');
  const typeIndex = new Array(n).fill(0);
  const types = [''];
  const typeIds = new Map([['', 0]]);
  const instanceOf = new Array(n).fill(0);
  const own = new Array(n); // public properties per object, before type inheritance

  const range = id => [2 * offs[id], id === n - 1 ? avs.length : 2 * offs[id + 1]];
  for (let id = 1; id < n; id++) {
    const [start, end] = range(id);
    let category = '', typeProp = '';
    const props = [];
    for (let i = start; i < end; i += 2) {
      const attr = attrs[avs[i]];
      if (!Array.isArray(attr)) continue;
      const value = vals[avs[i + 1]];
      const [attrName, attrCategory, , context, , displayName, flags] = attr;
      if (typeof attrCategory === 'string' && INTERNAL.test(attrCategory)) {
        if (attrCategory === '__parent__') parent[id] = Number(value) || 0;
        else if (attrCategory === '__name__') name[id] = String(value ?? '');
        else if (attrCategory === '__category__') category = String(value ?? '');
        else if (attrCategory === '__instanceof__') instanceOf[id] = Number(value) || 0;
        continue;
      }
      if ((Number(flags) & HIDDEN_FLAG) || value === undefined || value === null || value === '') continue;
      const label = (typeof displayName === 'string' && displayName) || String(attrName ?? '');
      if (!typeProp && /^(type|유형)$/i.test(label)) typeProp = String(value);
      const unit = unitOf(context);
      props.push(unit ? [String(attrCategory ?? ''), label, cleanValue(value), unit] : [String(attrCategory ?? ''), label, cleanValue(value)]);
    }
    own[id] = props;
    const type = category || typeProp;
    if (type) {
      let t = typeIds.get(type);
      if (t === undefined) { t = types.length; types.push(type); typeIds.set(type, t); }
      typeIndex[id] = t;
    }
  }

  // Revit-style type objects: an instance shows its type's properties unless it overrides them.
  const shards = new Map();
  let propertyCount = 0;
  for (let id = 1; id < n; id++) {
    const props = own[id];
    const typeId = instanceOf[id];
    if (typeId > 0 && typeId < n && typeId !== id) {
      const seen = new Set(props.map(p => `${p[0]}\u0000${p[1]}`));
      for (const p of own[typeId]) if (!seen.has(`${p[0]}\u0000${p[1]}`)) props.push(p);
    }
    const externalId = ids?.[id];
    if (!props.length && !externalId) continue;
    const k = Math.floor(id / shardSize);
    let shard = shards.get(k);
    if (!shard) { shard = {}; shards.set(k, shard); }
    shard[id] = externalId ? { p: props, x: String(externalId) } : { p: props };
    propertyCount += props.length;
  }

  // Parents must point inside the database; a broken link becomes a root instead of a dangling node.
  for (let id = 1; id < n; id++) if (parent[id] <= 0 || parent[id] >= n || parent[id] === id) parent[id] = 0;

  return {
    tree: { v: 1, n, parent, name, type: typeIndex, types },
    shards,
    stats: { objects: n - 1, named: name.filter(Boolean).length, types: types.length - 1, shards: shards.size, properties: propertyCount },
  };
}
