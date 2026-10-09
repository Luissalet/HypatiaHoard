/**
 * sanitizeHtml.ts
 *
 * Allow-list HTML sanitizer for page cards (an HTML lesson that is reviewed whole).
 * DOM-free tokenizer, a port of hypatia/pages.py: scripts, styles, frames, forms, event
 * handlers, inline styles, remote images and javascript: links never survive. Images are
 * kept only as data:image/(png|jpeg|gif|webp) URIs. Idempotent.
 */

const ALLOWED = new Set(
  ('p br hr h1 h2 h3 h4 h5 h6 ul ol li strong b em i u s sub sup code pre blockquote table thead tbody tfoot ' +
    'tr th td caption colgroup col div span a img figure figcaption dl dt dd mark small abbr details summary ' +
    'section article header footer main nav aside kbd cite q del ins center').split(' '),
);
const VOID = new Set(['br', 'hr', 'img', 'col']);
const DROP_WITH_CONTENT = new Set(
  ('script style iframe frame frameset object embed applet noscript template svg math head title textarea ' +
    'select option button form canvas audio video map xmp noembed noframes').split(' '),
);
const GLOBAL_ATTRS = ['title', 'lang', 'dir'];
const DATA_IMG = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const SAFE_HREF = /^(?:https?:|mailto:|#)/i;
const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?\?>|<\/?[a-zA-Z][^>]*>|</g;
const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*?)(\/?)>$/;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000- \u007f-\u009f]+/g;

export const MAX_PAGE_HTML = 1_500_000;

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ',
  sol: '/', lpar: '(', rpar: ')', semi: ';', comma: ',', period: '.', num: '#', excl: '!', equals: '=',
  plus: '+', lowbar: '_', hyphen: '-',
};

function unescapeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z]{2,8});)/g, (m, dec, hex, name) => {
    try {
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
    } catch { return ''; }
    return name && name.toLowerCase() in NAMED ? NAMED[name.toLowerCase()] : m;
  });
}

const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (t: string) => t.replace(/</g, '&lt;');

function cleanAttrs(tag: string, rest: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(rest)) !== null) {
    const name = m[1].toLowerCase();
    if (seen.has(name)) continue;
    const value = unescapeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    let keep: string | null = null;
    if (GLOBAL_ATTRS.includes(name)) {
      keep = value.slice(0, 300);
    } else if (tag === 'a' && name === 'href') {
      const compact = value.replace(CTRL, '');
      if (SAFE_HREF.test(compact)) keep = compact.slice(0, 2000);
    } else if (tag === 'img' && name === 'src') {
      const compact = value.replace(CTRL, '');
      if (DATA_IMG.test(compact)) keep = compact;
    } else if (tag === 'img' && name === 'alt') {
      keep = value.slice(0, 500);
    } else if ((tag === 'img' && (name === 'width' || name === 'height')) || ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan'))) {
      if (/^\d{1,4}$/.test(value.trim())) keep = value.trim();
    }
    if (keep !== null) {
      seen.add(name);
      out.push(` ${name}="${escAttr(keep)}"`);
    }
  }
  if (tag === 'img' && !out.some((a) => a.startsWith(' src='))) return '';
  if (tag === 'a' && out.some((a) => a.startsWith(' href='))) out.push(' target="_blank" rel="noopener noreferrer"');
  return out.join('');
}

/** Allow-list sanitizer. Returns a safe HTML fragment (possibly empty). */
export function sanitizeHtml(source: string): string {
  const src = (source ?? '').replace(/\u0000/g, '');
  const out: string[] = [];
  const stack: string[] = [];
  let pos = 0;
  let skipping: string | null = null;
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(src)) !== null) {
    if (m.index > pos && skipping === null) out.push(escText(src.slice(pos, m.index)));
    pos = m.index + m[0].length;
    const token = m[0];
    if (token === '<') {
      if (skipping === null) out.push('&lt;');
      continue;
    }
    if (token.startsWith('<!') || token.startsWith('<?')) continue;
    const t = TAG.exec(token);
    if (!t) continue;
    const closing = t[1] === '/';
    const name = t[2].toLowerCase();
    const rest = t[3];
    const selfClose = t[4] === '/';
    if (skipping !== null) {
      if (closing && name === skipping) skipping = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !selfClose && !rest.trimEnd().endsWith('/')) skipping = name;
      continue;
    }
    if (!ALLOWED.has(name)) continue;
    if (closing) {
      if (stack.includes(name)) {
        while (stack.length) {
          const top = stack.pop() as string;
          out.push(`</${top}>`);
          if (top === name) break;
        }
      }
      continue;
    }
    const attrs = cleanAttrs(name, rest);
    if (name === 'img') {
      if (attrs) out.push(`<img${attrs}>`);
      continue;
    }
    if (VOID.has(name)) {
      out.push(`<${name}>`);
      continue;
    }
    out.push(`<${name}${attrs}>`);
    stack.push(name);
  }
  if (skipping === null && pos < src.length) out.push(escText(src.slice(pos)));
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('').trim();
}

const BLOCK = /<\/?(?:p|div|br|hr|h[1-6]|li|ul|ol|tr|table|blockquote|pre|section|article|figure|figcaption|dt|dd|details|summary)\b[^>]*>/gi;

/** Plain text of already-sanitized HTML (line breaks at block boundaries). */
export function htmlToText(cleanHtml: string): string {
  let text = cleanHtml.replace(BLOCK, '\n').replace(/<[^>]+>/g, '');
  text = unescapeEntities(text).replace(/[ \t\r\f\v]+/g, ' ');
  return text.replace(/ ?\n ?/g, '\n').replace(/\n\s*\n+/g, '\n\n').trim();
}

/** Title of a pasted/imported document: <title>, else the first <h1>. */
export function htmlTitle(source: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source);
  if (!m) return null;
  const t = unescapeEntities(m[1].replace(/<[^>]+>/g, '')).split(/\s+/).filter(Boolean).join(' ').slice(0, 200);
  return t || null;
}
