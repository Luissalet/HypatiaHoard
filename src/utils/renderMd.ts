/**
 * renderMd.ts
 *
 * Utilidad compartida para renderizar Markdown con soporte KaTeX.
 *
 * Soporta los delimitadores más habituales:
 *   - $...$ y $$...$$ (estilo pandoc/KaTeX)
 *   - \(...\) y \[...\]  (estilo LaTeX)
 *
 * Preprocesa el texto para:
 *   1. Normalizar \(...\)/\[...\] → $...$/$$..$$ (marked-katex-extension format)
 *   2. Colapsar saltos de línea dentro de $$...$$ (marked los rompería como párrafos)
 */

import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import 'katex/dist/katex.min.css';

// Configura marked+KaTeX una sola vez al importar el módulo
marked.use(
  markedKatex({
    throwOnError: false,
    nonStandard: true, // permite $...$ además de $$...$$
  })
);

/**
 * Convierte delimitadores \(...\) y \[...\] a los equivalentes
 * $...$ y $$...$$ que entiende marked-katex-extension.
 */
function normalizeLatexDelimiters(text: string): string {
  return text
    // \[...\]  →  $$\n...\n$$   (display math)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, math) => `$$\n${math}\n$$`)
    // \(...\)  →  $...$           (inline math)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, math) => `$${math}$`);
}

/**
 * Colapsa saltos de línea dentro de bloques $$...$$ a espacios.
 *
 * marked-katex-extension no soporta display math multilínea: si el contenido
 * entre $$ tiene \n, marked lo trata como párrafos Markdown normales y KaTeX
 * nunca lo procesa. Esta función convierte esos \n en espacios para que el
 * bloque se mantenga íntegro.
 *
 * Esto es especialmente importante para matrices, aligned, cases, etc. que
 * los LLMs suelen generar con saltos de línea reales.
 */
function collapseDisplayMathNewlines(text: string): string {
  return text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, math) => {
    return '$$' + math.replace(/\n/g, ' ') + '$$';
  });
}

/** Renderiza texto Markdown (con LaTeX) a HTML. */
export function renderMd(text: string): string {
  if (!text) return '';
  try {
    let processed = normalizeLatexDelimiters(text);
    processed = collapseDisplayMathNewlines(processed);
    return marked.parse(processed, { async: false }) as string;
  } catch {
    return text;
  }
}