/**
 * MindMap.tsx
 *
 * Collapsible mind map as a left-to-right SVG tree. No external libraries:
 * a tiny tidy-tree layout (leaves stacked vertically, parents centred on
 * their children, columns sized to the widest label of each depth).
 * Click a node with children to fold/unfold it.
 */

import { useMemo, useState } from 'react';
import type { MindMapNode } from '@/data/hoardClient';
import { useTheme } from '@/ui/context/ThemeContext';

const ROW_H = 34;
const NODE_H = 26;
const COL_GAP = 36;
const PAD = 12;
const CHAR_W = 6.6;
const MAX_CHARS = 34;
const MIN_W = 56;

interface LaidOut {
  path: string;
  node: MindMapNode;
  depth: number;
  x: number;
  y: number;
  w: number;
  label: string;
  hasChildren: boolean;
  collapsed: boolean;
  parentPath: string | null;
}

function truncate(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_CHARS ? clean.slice(0, MAX_CHARS - 1) + '…' : clean;
}

function nodeWidth(label: string): number {
  return Math.max(MIN_W, Math.round(label.length * CHAR_W + 20));
}

/** Normalises whatever the server sent into a MindMapNode tree. */
export function toMindMapRoot(data: unknown, fallbackLabel = 'Mapa mental'): MindMapNode | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const candidate = (o.root ?? o.tree ?? o) as Record<string, unknown>;
  const walk = (n: Record<string, unknown>, depth: number): MindMapNode => {
    const kids = Array.isArray(n.children) ? (n.children as Record<string, unknown>[]) : [];
    return {
      label: String(n.label ?? n.title ?? n.name ?? n.text ?? '').trim() || (depth === 0 ? fallbackLabel : '·'),
      refs: Array.isArray(n.refs) ? (n.refs as unknown[]).map(Number).filter(Number.isFinite) : undefined,
      children: depth < 8 ? kids.filter((k) => k && typeof k === 'object').map((k) => walk(k, depth + 1)) : [],
    };
  };
  return walk(candidate, 0);
}

function initialCollapsed(root: MindMapNode, openDepth: number): Set<string> {
  const set = new Set<string>();
  const visit = (n: MindMapNode, path: string, depth: number) => {
    if (depth >= openDepth && n.children?.length) set.add(path);
    n.children?.forEach((c, i) => visit(c, `${path}.${i}`, depth + 1));
  };
  visit(root, '0', 0);
  return set;
}

function layout(root: MindMapNode, collapsed: Set<string>): { nodes: LaidOut[]; width: number; height: number } {
  // 1. Visible nodes + column widths
  const visible: { node: MindMapNode; path: string; depth: number; parentPath: string | null }[] = [];
  const colW: number[] = [];
  const collect = (n: MindMapNode, path: string, depth: number, parentPath: string | null) => {
    visible.push({ node: n, path, depth, parentPath });
    colW[depth] = Math.max(colW[depth] ?? 0, nodeWidth(truncate(n.label)));
    if (!collapsed.has(path)) n.children?.forEach((c, i) => collect(c, `${path}.${i}`, depth + 1, path));
  };
  collect(root, '0', 0, null);

  const colX: number[] = [];
  let acc = PAD;
  for (let d = 0; d < colW.length; d++) {
    colX[d] = acc;
    acc += colW[d] + COL_GAP;
  }

  // 2. y: leaves in order, parents centred
  const ys = new Map<string, number>();
  let row = 0;
  const place = (n: MindMapNode, path: string): number => {
    const kids = collapsed.has(path) ? [] : n.children ?? [];
    let y: number;
    if (kids.length === 0) {
      y = PAD + row * ROW_H + NODE_H / 2;
      row++;
    } else {
      const childYs = kids.map((c, i) => place(c, `${path}.${i}`));
      y = (childYs[0] + childYs[childYs.length - 1]) / 2;
    }
    ys.set(path, y);
    return y;
  };
  place(root, '0');

  const nodes: LaidOut[] = visible.map(({ node, path, depth, parentPath }) => {
    const label = truncate(node.label);
    return {
      path, node, depth, parentPath, label,
      x: colX[depth],
      y: ys.get(path) ?? 0,
      w: nodeWidth(label),
      hasChildren: !!node.children?.length,
      collapsed: collapsed.has(path),
    };
  });

  return { nodes, width: acc - COL_GAP + PAD, height: PAD * 2 + Math.max(1, row) * ROW_H };
}

interface MindMapProps {
  root: MindMapNode;
  /** Called with a node's refs (citation numbers) when it has any. */
  onRefs?: (refs: number[], anchor: DOMRect) => void;
}

export function MindMap({ root, onRefs }: MindMapProps) {
  // SVG fills are not reached by the light theme's class overrides (index.css)
  const light = useTheme().theme === 'light';
  const foldFill = light ? '#ffffff' : '#141210';
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapsed(root, 2));
  const { nodes, width, height } = useMemo(() => layout(root, collapsed), [root, collapsed]);
  const byPath = useMemo(() => new Map(nodes.map((n) => [n.path, n])), [nodes]);

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(initialCollapsed(root, 1));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <button type="button" onClick={expandAll} className="text-ink-400 hover:text-amber-400 transition-colors">
          Expandir todo
        </button>
        <span className="text-ink-600">·</span>
        <button type="button" onClick={collapseAll} className="text-ink-400 hover:text-amber-400 transition-colors">
          Contraer
        </button>
        <span className="text-ink-600 ml-auto hidden sm:inline">Pulsa un nodo para abrirlo o cerrarlo</span>
      </div>
      <div className="overflow-auto rounded-xl border border-ink-700 bg-ink-900 max-h-[70vh]">
        <svg width={width} height={height} className="block font-body" role="tree" aria-label="Mapa mental">
          {/* Edges */}
          {nodes.map((n) => {
            if (!n.parentPath) return null;
            const p = byPath.get(n.parentPath);
            if (!p) return null;
            const x1 = p.x + p.w;
            const y1 = p.y;
            const x2 = n.x;
            const y2 = n.y;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={`e-${n.path}`}
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                fill="none"
                stroke="#f59e0b"
                strokeOpacity={0.35}
                strokeWidth={1.5}
              />
            );
          })}
          {/* Nodes */}
          {nodes.map((n) => {
            const isRoot = n.depth === 0;
            const clickable = n.hasChildren || !!n.node.refs?.length;
            return (
              <g
                key={n.path}
                transform={`translate(${n.x},${n.y - NODE_H / 2})`}
                onClick={(e) => {
                  if (n.hasChildren) toggle(n.path);
                  else if (n.node.refs?.length && onRefs) {
                    onRefs(n.node.refs, (e.currentTarget as SVGGElement).getBoundingClientRect());
                  }
                }}
                className={clickable ? 'cursor-pointer' : undefined}
                role="treeitem"
                aria-expanded={n.hasChildren ? !n.collapsed : undefined}
              >
                <title>{n.node.label}{n.node.refs?.length ? ` [${n.node.refs.join(', ')}]` : ''}</title>
                <rect
                  width={n.w}
                  height={NODE_H}
                  rx={8}
                  fill="#f59e0b"
                  fillOpacity={isRoot ? 0.9 : n.depth === 1 ? 0.2 : 0.1}
                  stroke="#f59e0b"
                  strokeOpacity={isRoot ? 1 : 0.45}
                />
                <text
                  x={10}
                  y={NODE_H / 2}
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight={isRoot || n.depth === 1 ? 600 : 400}
                  className={isRoot ? undefined : 'fill-current text-ink-200'}
                  fill={isRoot ? '#0a0907' : undefined}
                >
                  {n.label}
                </text>
                {n.hasChildren && (
                  <g transform={`translate(${n.w},${NODE_H / 2})`}>
                    <circle r={7} fill={foldFill} stroke="#f59e0b" strokeOpacity={0.7} />
                    <text textAnchor="middle" dominantBaseline="central" fontSize={10} fill={light ? '#b45309' : '#f59e0b'}>
                      {n.collapsed ? '+' : '−'}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
