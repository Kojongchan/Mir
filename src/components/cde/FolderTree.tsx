import { useState } from 'react';
import { buildFolderTree, type Folder } from '../../lib/cde';

interface Props {
  folders: Folder[];
  selectedId: string | null; // null = root
  onSelect: (folderId: string | null) => void;
  /** Label for the synthetic root node (문서 섹션: "전체 · 미분류"). */
  rootLabel?: string;
  /** Whether to render the synthetic null root. BIM 섹션은 미분류가 없어 false. */
  showRoot?: boolean;
}

/**
 * Recursive folder tree for the CDE document manager. The synthetic root
 * ("전체 / 미분류") holds files with no folder. Selecting a node drives the
 * file table on the right. With `showRoot=false` only the real folders render
 * (used by the BIM 데이터 섹션, which has no unfiled bucket).
 */
export function FolderTree({ folders, selectedId, onSelect, rootLabel = '전체 · 미분류', showRoot = true }: Props) {
  const byParent = buildFolderTree(folders);
  return (
    <ul className="cde-tree">
      <li>
        {showRoot && (
          <button
            className={`cde-tree-node${selectedId === null ? ' is-active' : ''}`}
            onClick={() => onSelect(null)}
          >
            <span className="cde-tree-ico">🗂</span>
            <span className="cde-tree-label">{rootLabel}</span>
          </button>
        )}
        <Branch parentId={null} byParent={byParent} selectedId={selectedId} onSelect={onSelect} />
      </li>
    </ul>
  );
}

function Branch({
  parentId,
  byParent,
  selectedId,
  onSelect,
  depth = 0,
}: {
  parentId: string | null;
  byParent: Map<string | null, Folder[]>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  depth?: number;
}) {
  const children = byParent.get(parentId) ?? [];
  if (children.length === 0) return null;
  return (
    <ul className="cde-tree-children">
      {children.map((f) => (
        <Node key={f.id} folder={f} byParent={byParent} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
      ))}
    </ul>
  );
}

function Node({
  folder,
  byParent,
  selectedId,
  onSelect,
  depth,
}: {
  folder: Folder;
  byParent: Map<string | null, Folder[]>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  depth: number;
}) {
  const hasChildren = (byParent.get(folder.id) ?? []).length > 0;
  const [open, setOpen] = useState(true);
  return (
    <li>
      <div className="cde-tree-row" style={{ paddingLeft: depth * 12 }}>
        <button
          className="cde-tree-twisty"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? '접기' : '펼치기'}
          disabled={!hasChildren}
        >
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </button>
        <button
          className={`cde-tree-node${selectedId === folder.id ? ' is-active' : ''}`}
          onClick={() => onSelect(folder.id)}
          title={folder.name}
        >
          <span className="cde-tree-ico">📁</span>
          <span className="cde-tree-label">{folder.name}</span>
        </button>
      </div>
      {open && <Branch parentId={folder.id} byParent={byParent} selectedId={selectedId} onSelect={onSelect} depth={depth} />}
    </li>
  );
}
