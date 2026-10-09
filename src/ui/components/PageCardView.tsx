/**
 * PageCardView.tsx
 *
 * Shows a page card's lesson. The HTML is sanitized again here (defense in depth, in case
 * it arrived by sync) and rendered inside a sandboxed iframe with a CSP that forbids
 * scripts and every remote resource: only data: images and inline styles of our own.
 */

import { useMemo } from 'react';
import { sanitizeHtml } from '@/utils/sanitizeHtml';

const FRAME_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; padding: 4px 2px 12px; font: 15px/1.6 system-ui, sans-serif; color: #e6e1d8; background: transparent; overflow-wrap: anywhere; }
  h1,h2,h3,h4 { color: #f3ede0; line-height: 1.25; margin: 1.1em 0 .4em; } h1 { font-size: 1.5em; } h2 { font-size: 1.25em; }
  a { color: #e0b252; } img { max-width: 100%; height: auto; border-radius: 6px; }
  code, pre { background: #1d1b18; border-radius: 4px; padding: .1em .35em; } pre { padding: .7em; overflow-x: auto; }
  blockquote { margin: .8em 0; padding: .1em 1em; border-left: 3px solid #5c5547; color: #bdb6a8; }
  table { border-collapse: collapse; } td, th { border: 1px solid #4a4439; padding: .3em .6em; } mark { background: #6b5514; color: #fff; }
`;

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export function pageFrameDoc(pageHtml: string): string {
  const body = sanitizeHtml(pageHtml);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<base target="_blank"><style>${FRAME_CSS}</style></head><body>${body}</body></html>`;
}

export function PageCardView({ html, className = '' }: { html: string; className?: string }) {
  const doc = useMemo(() => pageFrameDoc(html), [html]);
  return (
    <iframe
      title="Página de estudio"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      data-testid="page-card-frame"
      className={`w-full rounded-xl border border-ink-700 bg-ink-900/60 ${className}`}
      style={{ height: '56vh', minHeight: '320px' }}
    />
  );
}
