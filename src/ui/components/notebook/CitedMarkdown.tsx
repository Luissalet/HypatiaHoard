/**
 * CitedMarkdown.tsx
 *
 * Markdown + KaTeX (same renderer as MdContent) where inline citation markers
 * like [3] or [1, 4] become clickable chips that open the citation popover.
 */

import { useEffect, useMemo, useRef } from 'react';
import { renderMd } from '@/utils/renderMd';
import type { Citation } from '@/data/hoardClient';
import { useNotebook } from './NotebookContext';

/**
 * Typography for generated markdown (the app has no prose plugin). Colours are
 * inherited from the container's `text-ink-200` (which the light theme remaps in
 * index.css) or use amber with alpha: arbitrary variants like `[&_h1]:text-ink-100`
 * are not covered by the light-theme overrides and would stay near-white.
 */
export const NOTEBOOK_MD_CLASS = [
  'text-sm text-ink-200 leading-relaxed break-words',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h1]:font-display [&_h1]:text-xl [&_h1]:mt-5 [&_h1]:mb-2',
  '[&_h2]:font-display [&_h2]:text-lg [&_h2]:mt-5 [&_h2]:mb-2',
  '[&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-1.5',
  '[&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1',
  '[&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0',
  '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2 [&_li]:my-0.5',
  '[&_strong]:font-semibold [&_a]:text-amber-500 [&_a]:underline',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-amber-500/40 [&_blockquote]:pl-3 [&_blockquote]:opacity-90',
  '[&_code]:font-mono [&_code]:text-xs [&_code]:bg-amber-500/10 [&_code]:px-1 [&_code]:rounded',
  '[&_pre]:bg-amber-500/5 [&_pre]:border [&_pre]:border-amber-500/15 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto',
  '[&_table]:w-full [&_table]:text-xs [&_table]:my-3 [&_th]:text-left [&_th]:font-semibold [&_th]:border-b [&_th]:border-amber-500/25 [&_th]:py-1 [&_th]:pr-2',
  '[&_td]:border-b [&_td]:border-amber-500/10 [&_td]:py-1 [&_td]:pr-2 [&_td]:align-top',
  '[&_hr]:border-amber-500/20 [&_hr]:my-4',
].join(' ');

const MARKER = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g;
const CHIP_CLASS =
  'hy-cite inline-flex items-center justify-center min-w-[1.25rem] px-1 mx-0.5 rounded text-[10px] leading-4 align-super font-mono font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 cursor-pointer';

/** Replaces [n] markers in text nodes (outside code and KaTeX) with chip buttons. */
function decorate(container: HTMLElement, known: Set<number>): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('code, pre, .katex, .hy-cite')) return NodeFilter.FILTER_REJECT;
      MARKER.lastIndex = 0;
      return MARKER.test(node.nodeValue ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  for (const node of nodes) {
    const text = node.nodeValue ?? '';
    const frag = document.createDocumentFragment();
    let last = 0;
    MARKER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER.exec(text))) {
      const nums = m[1].split(/[,;]/).map((x) => parseInt(x.trim(), 10));
      // Only decorate markers we have citations for (avoid "[2]" in plain text)
      if (known.size > 0 && !nums.some((n) => known.has(n))) continue;
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      for (const n of nums) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = CHIP_CLASS;
        btn.dataset.cite = String(n);
        btn.textContent = String(n);
        frag.appendChild(btn);
      }
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}

interface CitedMarkdownProps {
  content: string;
  citations?: Citation[];
  className?: string;
}

export function CitedMarkdown({ content, citations = [], className = '' }: CitedMarkdownProps) {
  const { showCitation } = useNotebook();
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMd(content || ''), [content]);
  const byN = useMemo(() => new Map(citations.map((c) => [c.n, c])), [citations]);

  useEffect(() => {
    if (ref.current) decorate(ref.current, new Set(byN.keys()));
  }, [html, byN]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cite]');
    if (!btn) return;
    const n = Number(btn.dataset.cite);
    const c = byN.get(n) ?? { n };
    showCitation(c, btn.getBoundingClientRect());
  };

  return (
    <div
      ref={ref}
      onClick={onClick}
      className={`${NOTEBOOK_MD_CLASS} ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
