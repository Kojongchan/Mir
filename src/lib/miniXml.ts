// =====================================================================
// 최소 XML 파서 — MS Project(.xml) 임포트용. 브라우저 DOMParser 는 web 전용이고
// node 스모크 테스트에선 쓸 수 없어, 의존성 없이 두 환경 모두에서 동작하는 작은
// 트리 파서를 둔다. 잘 정형화된(well-formed) MS Project XML 에 충분하다:
// 요소 중첩·텍스트·self-closing·CDATA·엔티티·주석·선언(<?…?>)을 처리한다.
// (속성은 MS Project 태스크 필드에 불필요해 파싱만 하고 버린다.)
// =====================================================================

export interface XmlNode {
  tag: string;
  children: XmlNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // amp 마지막(이중 디코딩 방지)
}

/** XML 문자열 → 루트 노드. 파싱 실패 시 빈 루트. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '#root', children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    // 태그 앞의 텍스트를 현재 노드에 누적.
    if (lt > i) {
      const txt = xml.slice(i, lt);
      if (txt.trim()) stack[stack.length - 1].text += decodeEntities(txt);
    }
    // 주석/선언/CDATA 처리.
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      const data = xml.slice(lt + 9, end < 0 ? n : end);
      stack[stack.length - 1].text += data;
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    let inner = xml.slice(lt + 1, gt).trim();
    if (inner.startsWith('/')) {
      // 닫는 태그 — 스택 pop.
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClose = inner.endsWith('/');
    if (selfClose) inner = inner.slice(0, -1).trim();
    const tag = inner.split(/[\s/]/)[0];
    const node: XmlNode = { tag, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  return root;
}

/** 첫 번째 자식(직계) 태그 매칭. */
export function child(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

/** 직계 자식 중 태그 매칭 전부. */
export function children(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((c) => c.tag === tag);
}

/** 하위(재귀) 전체에서 태그 매칭 전부. */
export function descendants(node: XmlNode, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (nd: XmlNode) => {
    for (const c of nd.children) {
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** 직계 자식 태그의 텍스트(트림). 없으면 ''. */
export function childText(node: XmlNode, tag: string): string {
  return child(node, tag)?.text.trim() ?? '';
}
