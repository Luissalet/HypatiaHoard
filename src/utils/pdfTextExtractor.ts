/**
 * pdfTextExtractor.ts
 *
 * Extracción inteligente de texto de PDFs respetando layout:
 *   - Usa info de fuente (tamaño, bold) para detectar títulos y secciones
 *   - Detecta columnas y mantiene orden de lectura correcto
 *   - Elimina headers/footers/números de página
 *   - Detecta y formatea tablas para lectura TTS
 *   - Detecta callout boxes (⚠ IMPORTANTE PARA EXAMEN)
 *   - Agrupa en párrafos semánticos con merge inteligente
 */

import * as pdfjsLib from 'pdfjs-dist';

// Asegurar que el worker está configurado
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).href;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TextBlock {
  /** Texto limpio del bloque */
  text: string;
  /** Índice de página (0-indexed) */
  pageIndex: number;
  /** Tipo de contenido detectado */
  type: 'paragraph' | 'heading' | 'math' | 'list' | 'table' | 'callout';
  /** Posición Y normalizada (0-1) en la página — para scroll sync */
  yPosition: number;
}

export interface ExtractionResult {
  blocks: TextBlock[];
  /** Número total de páginas procesadas */
  totalPages: number;
  /** Páginas que no pudieron procesarse */
  errors: { page: number; error: string }[];
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  /** Nombre de fuente interno de pdf.js (ej: "g_d0_f1") */
  fontName: string;
  /** Tamaño de fuente efectivo (pts) derivado de la transform */
  fontSize: number;
  /** true si la fuente contiene "Bold" en su familia */
  isBold: boolean;
}

interface LineGroup {
  y: number;
  items: TextItem[];
  /** Tamaño de fuente predominante en la línea */
  dominantFontSize: number;
  /** true si la mayoría de chars son bold */
  isBold: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const Y_TOLERANCE = 3;
const PARAGRAPH_GAP = 12;
const MATH_CHAR_REGEX = /[\u0391-\u03C9\u2200-\u22FF\u2A00-\u2AFF∑∏∫∂√∞≈≠≤≥±×÷∈∉⊂⊃∪∩∀∃∇∆λμσΣΠ]/;

// Table detection
const TABLE_CELL_MARGIN = 5;

// ─── Main Export ───────────────────────────────────────────────────────────────

/**
 * Extrae texto estructurado de un PDF.
 * @param source - URL del PDF o PDFDocumentProxy ya cargado
 * @param options - Opciones de extracción
 */
export async function extractPdfText(
  source: string | pdfjsLib.PDFDocumentProxy,
  options?: {
    /** Páginas a extraer (1-indexed). Si no se pasa, extrae todas. */
    pages?: number[];
    /** Callback de progreso (0-1) */
    onProgress?: (progress: number) => void;
  },
): Promise<ExtractionResult> {
  const pdfDoc =
    typeof source === 'string'
      ? await pdfjsLib.getDocument(source).promise
      : source;

  const totalPages = pdfDoc.numPages;
  const pagesToProcess = options?.pages ?? Array.from({ length: totalPages }, (_, i) => i + 1);
  const allBlocks: TextBlock[] = [];
  const errors: { page: number; error: string }[] = [];

  for (let idx = 0; idx < pagesToProcess.length; idx++) {
    const pageNum = pagesToProcess[idx];
    try {
      const pageBlocks = await extractPageBlocks(pdfDoc, pageNum);
      allBlocks.push(...pageBlocks);
    } catch (err) {
      errors.push({ page: pageNum, error: String(err) });
    }
    options?.onProgress?.((idx + 1) / pagesToProcess.length);
  }

  // Fusionar bloques pequeños consecutivos del mismo tipo para reducir cortes
  const merged = mergeSmallBlocks(allBlocks);

  return { blocks: merged, totalPages, errors };
}

// ─── Block merging ─────────────────────────────────────────────────────────────

const MAX_MERGED_LENGTH = 800;

function mergeSmallBlocks(blocks: TextBlock[]): TextBlock[] {
  if (blocks.length === 0) return blocks;
  const result: TextBlock[] = [];
  let acc: TextBlock | null = null;

  for (const block of blocks) {
    // Headings, tables, callouts siempre van solos
    if (block.type === 'heading' || block.type === 'table' || block.type === 'callout') {
      if (acc) { result.push(acc); acc = null; }
      result.push(block);
      continue;
    }

    if (!acc) {
      acc = { ...block };
      continue;
    }

    const canMerge =
      acc.type === block.type &&
      acc.pageIndex === block.pageIndex &&
      acc.text.length + block.text.length + 1 <= MAX_MERGED_LENGTH;

    if (canMerge) {
      acc.text = acc.text + ' ' + block.text;
    } else {
      result.push(acc);
      acc = { ...block };
    }
  }

  if (acc) result.push(acc);
  return result;
}

// ─── Per-page extraction ───────────────────────────────────────────────────────

async function extractPageBlocks(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
): Promise<TextBlock[]> {
  const page = await pdfDoc.getPage(pageNum);
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.0 });
  const pageHeight = viewport.height;
  const pageWidth = viewport.width;
  const styles = textContent.styles as Record<string, { fontFamily?: string }>;

  // Cast items y enriquecer con info de fuente
  let items: TextItem[] = (textContent.items as any[])
    .filter((it) => 'str' in it && it.str.trim().length > 0)
    .map((it) => {
      const fontName: string = it.fontName ?? '';
      const fontFamily: string = styles[fontName]?.fontFamily ?? '';
      const fontSize = Math.abs(it.transform[0]) || Math.abs(it.transform[3]) || 11;
      const isBold =
        /bold/i.test(fontFamily) ||
        /Bold/i.test(fontName) ||
        /\bBd\b/i.test(fontFamily);

      return {
        str: it.str,
        transform: it.transform,
        width: it.width ?? 0,
        height: it.height ?? 0,
        fontName,
        fontSize: Math.round(fontSize * 10) / 10,
        isBold,
      };
    });

  // ── Step 1: Filter headers, footers, page numbers ──────────────────────────
  const HEADER_ZONE = pageHeight * 0.06;
  const FOOTER_ZONE = pageHeight * 0.94;

  items = items.filter((item) => {
    const y = pageHeight - item.transform[5];
    return y >= HEADER_ZONE && y <= FOOTER_ZONE;
  });

  // Filter isolated page numbers
  items = items.filter((item) => {
    const y = pageHeight - item.transform[5];
    const isEdge = y < pageHeight * 0.1 || y > pageHeight * 0.9;
    const isJustNumber = /^\s*\d{1,4}\s*$/.test(item.str);
    return !(isEdge && isJustNumber);
  });

  // Filter recurring header text (ej: "Resumen – ..." en todas las páginas)
  items = items.filter((item) => {
    const y = pageHeight - item.transform[5];
    if (y < pageHeight * 0.08 && item.fontSize <= 10) return false;
    return true;
  });

  // Filter "Página N" footer text
  items = items.filter((item) => {
    const y = pageHeight - item.transform[5];
    if (y > pageHeight * 0.9 && /^P[áa]gina\s*\d+$/i.test(item.str.trim())) return false;
    return true;
  });

  if (items.length === 0) return [];

  // ── Step 2: Compute median body font size ──────────────────────────────────
  const fontSizes = items.map((it) => it.fontSize).sort((a, b) => a - b);
  const bodyFontSize = fontSizes[Math.floor(fontSizes.length / 2)];

  // ── Step 3: Detect tables (dual strategy) ──────────────────────────────────
  const structGrids = await detectTableGridFromStructure(page, pageHeight);
  let { tableBlocks, remainingItems } = assignItemsToTableGrid(
    items, structGrids, pageHeight, pageNum - 1, bodyFontSize,
  );

  // Fallback: text-gap based table detection
  if (tableBlocks.length === 0) {
    const textGrids = detectTableFromTextGaps(remainingItems, pageHeight, bodyFontSize);
    if (textGrids.length > 0) {
      ({ tableBlocks, remainingItems } = assignItemsToTableGrid(
        items, textGrids, pageHeight, pageNum - 1, bodyFontSize,
      ));
    }
  } else {
    // Si ya detectamos tablas por grid, buscar tablas adicionales por texto
    // en los items restantes que no cayeron en ningún grid
    const extraGrids = detectTableFromTextGaps(remainingItems, pageHeight, bodyFontSize);
    if (extraGrids.length > 0) {
      const extra = assignItemsToTableGrid(
        remainingItems, extraGrids, pageHeight, pageNum - 1, bodyFontSize,
      );
      tableBlocks.push(...extra.tableBlocks);
      remainingItems = extra.remainingItems;
    }
  }

  // ── Step 4: Detect callout boxes (⚠ IMPORTANTE) ───────────────────────────
  const { calloutBlocks, afterCalloutItems } = extractCalloutBoxes(
    remainingItems, pageHeight, pageNum - 1,
  );
  remainingItems = afterCalloutItems;

  // ── Step 5: Group remaining items into lines ───────────────────────────────
  const lines = groupIntoLines(remainingItems, pageHeight);

  // ── Step 6: Detect columns ─────────────────────────────────────────────────
  const columns = detectColumns(lines, pageWidth);

  // ── Step 7: Build text with correct reading order ──────────────────────────
  let orderedLines: LineGroup[];
  if (columns) {
    orderedLines = [...columns.left, ...columns.right];
  } else {
    orderedLines = lines;
  }

  // ── Step 8: Group into paragraphs (font-aware) ────────────────────────────
  const paragraphBlocks = groupIntoParagraphs(orderedLines, pageHeight, pageNum - 1, bodyFontSize);

  // Merge all blocks sorted by Y position
  const allBlocks = [...tableBlocks, ...calloutBlocks, ...paragraphBlocks].sort(
    (a, b) => a.yPosition - b.yPosition,
  );

  return allBlocks;
}

// ─── Callout detection ─────────────────────────────────────────────────────────

/**
 * Detecta bloques tipo "⚠ IMPORTANTE PARA EXAMEN: ..." buscando el emoji ⚠
 * seguido de "IMPORTANTE" en la misma zona Y. Agrupa todas las líneas del
 * callout hasta que cambia la zona Y significativamente.
 */
function extractCalloutBoxes(
  items: TextItem[],
  pageHeight: number,
  pageIndex: number,
): { calloutBlocks: TextBlock[]; afterCalloutItems: TextItem[] } {
  const calloutBlocks: TextBlock[] = [];
  const usedIndices = new Set<number>();

  // Encontrar items que contienen ⚠ o "IMPORTANTE"
  for (let i = 0; i < items.length; i++) {
    if (usedIndices.has(i)) continue;

    const item = items[i];
    const text = item.str.trim();

    // Buscar inicio de callout: ⚠ o "IMPORTANTE PARA EXAMEN"
    const isCalloutStart =
      text.includes('⚠') ||
      (text.includes('IMPORTANTE') && text.includes('EXAMEN'));

    if (!isCalloutStart) continue;

    const startY = pageHeight - item.transform[5];
    usedIndices.add(i);
    const calloutItems: TextItem[] = [item];

    // Recoger todas las líneas del callout (dentro de ~40px de Y)
    for (let j = i + 1; j < items.length; j++) {
      if (usedIndices.has(j)) continue;
      const jY = pageHeight - items[j].transform[5];
      const gap = jY - startY;

      // El callout suele ser 1-3 líneas, ≤50px de gap
      if (gap >= 0 && gap < 50) {
        // Verificar que no sea un heading u otro bloque (font grande)
        if (items[j].fontSize > 13) break;
        calloutItems.push(items[j]);
        usedIndices.add(j);
      } else if (gap >= 50) {
        break;
      }
    }

    // Agrupar por líneas Y y concatenar
    const lineGroups = groupIntoLines(calloutItems, pageHeight);
    const calloutText = lineGroups
      .map((lg) => lg.items.map((it) => it.str).join('').trim())
      .join(' ')
      .replace(/⚠\s*/g, '')
      .trim();

    if (calloutText.length > 10) {
      calloutBlocks.push({
        text: `Importante para examen: ${calloutText.replace(/^IMPORTANTE\s*(PARA\s*EXAMEN)?\s*:?\s*/i, '')}`,
        pageIndex,
        type: 'callout',
        yPosition: startY / pageHeight,
      });
    }
  }

  const afterCalloutItems = items.filter((_, idx) => !usedIndices.has(idx));
  return { calloutBlocks, afterCalloutItems };
}

// ─── Line grouping ─────────────────────────────────────────────────────────────

function groupIntoLines(items: TextItem[], pageHeight: number): LineGroup[] {
  const sorted = [...items].sort((a, b) => {
    const ya = pageHeight - a.transform[5];
    const yb = pageHeight - b.transform[5];
    if (Math.abs(ya - yb) > Y_TOLERANCE) return ya - yb;
    return a.transform[4] - b.transform[4];
  });

  const lines: LineGroup[] = [];
  for (const item of sorted) {
    const y = pageHeight - item.transform[5];
    const lastLine = lines[lines.length - 1];
    if (lastLine && Math.abs(lastLine.y - y) < Y_TOLERANCE) {
      lastLine.items.push(item);
    } else {
      lines.push({ y, items: [item], dominantFontSize: 0, isBold: false });
    }
  }

  // Sort items dentro de cada línea por X, y calcular font dominante
  for (const line of lines) {
    line.items.sort((a, b) => a.transform[4] - b.transform[4]);

    // Font dominante: la que tiene más chars
    const fontCounts = new Map<number, number>();
    let boldChars = 0;
    let totalChars = 0;
    for (const item of line.items) {
      const len = item.str.length;
      fontCounts.set(item.fontSize, (fontCounts.get(item.fontSize) ?? 0) + len);
      if (item.isBold) boldChars += len;
      totalChars += len;
    }
    let maxCount = 0;
    for (const [size, count] of fontCounts) {
      if (count > maxCount) {
        maxCount = count;
        line.dominantFontSize = size;
      }
    }
    line.isBold = totalChars > 0 && boldChars / totalChars > 0.5;
  }

  return lines;
}

// ─── Column detection ──────────────────────────────────────────────────────────

function detectColumns(
  lines: LineGroup[],
  pageWidth: number,
): { left: LineGroup[]; right: LineGroup[] } | null {
  const COLUMN_GAP_THRESHOLD = pageWidth * 0.15;
  let columnGapX = -1;
  let gapCount = 0;

  for (const line of lines.slice(0, 30)) {
    for (let i = 0; i < line.items.length - 1; i++) {
      const gap =
        line.items[i + 1].transform[4] -
        (line.items[i].transform[4] + line.items[i].width);
      if (gap > COLUMN_GAP_THRESHOLD) {
        columnGapX =
          columnGapX < 0
            ? line.items[i + 1].transform[4]
            : (columnGapX + line.items[i + 1].transform[4]) / 2;
        gapCount++;
      }
    }
  }

  if (gapCount < 5 || columnGapX < 0) return null;

  const left: LineGroup[] = [];
  const right: LineGroup[] = [];

  for (const line of lines) {
    const leftItems = line.items.filter(
      (it) => it.transform[4] + it.width / 2 < columnGapX,
    );
    const rightItems = line.items.filter(
      (it) => it.transform[4] + it.width / 2 >= columnGapX,
    );
    if (leftItems.length) left.push({ ...line, items: leftItems });
    if (rightItems.length) right.push({ ...line, items: rightItems });
  }

  return { left, right };
}

// ─── Table detection via PDF structure (borders/lines/rectangles) ────────────

interface GridLine {
  pos: number;
  start: number;
  end: number;
}

interface TableGrid {
  rowYs: number[];
  colXs: number[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const PATH_OP_MOVE_TO = 13;
const PATH_OP_LINE_TO = 14;
const PATH_OP_CURVE_TO = 15;
const PATH_OP_CURVE_TO2 = 16;
const PATH_OP_CURVE_TO3 = 17;
const PATH_OP_CLOSE_PATH = 18;
const PATH_OP_RECTANGLE = 19;

function mulMat(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function ptTransform(ctm: number[], x: number, y: number): [number, number] {
  return [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5],
  ];
}

async function detectTableGridFromStructure(
  page: pdfjsLib.PDFPageProxy,
  pageHeight: number,
): Promise<TableGrid[]> {
  const opList = await page.getOperatorList();
  const hLines: GridLine[] = [];
  const vLines: GridLine[] = [];

  let ctm: number[] = [1, 0, 0, 1, 0, 0];
  const ctmStack: number[][] = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (fn === pdfjsLib.OPS.save) {
      ctmStack.push([...ctm]);
      continue;
    }
    if (fn === pdfjsLib.OPS.restore) {
      ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0];
      continue;
    }
    if (fn === pdfjsLib.OPS.transform) {
      const m = args as number[];
      ctm = mulMat(ctm, m);
      continue;
    }

    if (fn !== pdfjsLib.OPS.constructPath) continue;

    const subOps = args[0] as number[];
    const coords = args[1] as number[];

    let ci = 0;
    let moveX = 0, moveY = 0;

    for (const op of subOps) {
      switch (op) {
        case PATH_OP_MOVE_TO: {
          const [tx, ty] = ptTransform(ctm, coords[ci++], coords[ci++]);
          moveX = tx;
          moveY = ty;
          break;
        }

        case PATH_OP_LINE_TO: {
          const [lx, ly] = ptTransform(ctm, coords[ci++], coords[ci++]);

          if (Math.abs(ly - moveY) < 1.5 && Math.abs(lx - moveX) > 20) {
            hLines.push({
              pos: pageHeight - moveY,
              start: Math.min(moveX, lx),
              end: Math.max(moveX, lx),
            });
          } else if (Math.abs(lx - moveX) < 1.5 && Math.abs(ly - moveY) > 5) {
            vLines.push({
              pos: moveX,
              start: pageHeight - Math.max(moveY, ly),
              end: pageHeight - Math.min(moveY, ly),
            });
          }

          moveX = lx;
          moveY = ly;
          break;
        }

        case PATH_OP_RECTANGLE: {
          const rx = coords[ci++];
          const ry = coords[ci++];
          const rw = coords[ci++];
          const rh = coords[ci++];

          const [x1, y1] = ptTransform(ctm, rx, ry);
          const [x2, y2] = ptTransform(ctm, rx + rw, ry + rh);

          const left = Math.min(x1, x2);
          const right = Math.max(x1, x2);
          const bottom = Math.min(y1, y2);
          const top = Math.max(y1, y2);

          const w = right - left;
          const h = top - bottom;

          if (h < 3 && w > 20) {
            hLines.push({
              pos: pageHeight - top,
              start: left,
              end: right,
            });
          } else if (w < 3 && h > 5) {
            vLines.push({
              pos: left,
              start: pageHeight - top,
              end: pageHeight - bottom,
            });
          }
          break;
        }

        case PATH_OP_CURVE_TO: ci += 6; break;
        case PATH_OP_CURVE_TO2: ci += 4; break;
        case PATH_OP_CURVE_TO3: ci += 4; break;
        case PATH_OP_CLOSE_PATH: break;
        default: break;
      }
    }
  }

  if (hLines.length < 3 || vLines.length < 3) return [];

  const hClusters = clusterLinePositions(hLines, 5);
  const vClusters = clusterLinePositions(vLines, 5);

  if (hClusters.length < 3 || vClusters.length < 3) return [];

  hClusters.sort((a, b) => a - b);
  vClusters.sort((a, b) => a - b);

  // ── NUEVO: Dividir en grids independientes ────────────────────────────────
  // Si hay líneas horizontales con gaps grandes entre ellas, puede haber
  // múltiples tablas. Detectamos gaps > 50px entre filas consecutivas.
  const grids: TableGrid[] = [];
  let gridStart = 0;

  for (let i = 1; i < hClusters.length; i++) {
    const gap = hClusters[i] - hClusters[i - 1];
    if (gap > 80 || i === hClusters.length - 1) {
      const endIdx = gap > 80 ? i - 1 : i;
      const rows = hClusters.slice(gridStart, endIdx + 1);

      if (rows.length >= 3) {
        // Filtrar columnas que están dentro del rango Y de esta tabla
        const minY = rows[0];
        const maxY = rows[rows.length - 1];
        const relevantVLines = vLines.filter(
          (vl) => vl.start <= maxY + 5 && vl.end >= minY - 5,
        );
        const relevantVClusters = clusterLinePositions(relevantVLines, 5);

        if (relevantVClusters.length >= 2) {
          relevantVClusters.sort((a, b) => a - b);
          grids.push({
            rowYs: rows,
            colXs: relevantVClusters,
            bounds: {
              minX: relevantVClusters[0],
              maxX: relevantVClusters[relevantVClusters.length - 1],
              minY: rows[0],
              maxY: rows[rows.length - 1],
            },
          });
        }
      }

      gridStart = gap > 80 ? i : i + 1;
    }
  }

  // Si no se particionó, intentar como tabla única
  if (grids.length === 0 && hClusters.length >= 3 && vClusters.length >= 2) {
    grids.push({
      rowYs: hClusters,
      colXs: vClusters,
      bounds: {
        minX: vClusters[0],
        maxX: vClusters[vClusters.length - 1],
        minY: hClusters[0],
        maxY: hClusters[hClusters.length - 1],
      },
    });
  }

  return grids;
}

function clusterLinePositions(lines: GridLine[], tolerance: number): number[] {
  const values = lines.map((l) => l.pos).sort((a, b) => a - b);
  if (values.length === 0) return [];

  const clusters: number[][] = [[values[0]]];

  for (let i = 1; i < values.length; i++) {
    const lastCluster = clusters[clusters.length - 1];
    const lastVal = lastCluster[lastCluster.length - 1];
    if (values[i] - lastVal <= tolerance) {
      lastCluster.push(values[i]);
    } else {
      clusters.push([values[i]]);
    }
  }

  return clusters.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
}

// ─── Fallback: text-based table detection ───────────────────────────────────

function detectTableFromTextGaps(
  items: TextItem[],
  pageHeight: number,
  bodyFontSize: number,
): TableGrid[] {
  const lines = groupIntoLines(items, pageHeight);
  if (lines.length < 3) return [];

  const GAP_THRESHOLD = 25;
  const X_ALIGN_TOL = 15;

  interface LineCols { lineIdx: number; colXs: number[]; numItems: number; }

  const lineColInfo: LineCols[] = lines.map((line, idx) => {
    const colXs: number[] = [line.items[0]?.transform[4] ?? 0];
    for (let i = 1; i < line.items.length; i++) {
      const prevEnd = line.items[i - 1].transform[4] + line.items[i - 1].width;
      const curStart = line.items[i].transform[4];
      if (curStart - prevEnd > GAP_THRESHOLD) {
        colXs.push(curStart);
      }
    }
    return { lineIdx: idx, colXs, numItems: line.items.length };
  });

  // ── NUEVO: No considerar líneas que son headings (font grande) ────────────
  const tableLineInfo = lineColInfo.map((info, idx) => {
    const line = lines[idx];
    const isHeading = line.dominantFontSize > bodyFontSize * 1.15 && line.isBold;
    return { ...info, isHeading };
  });

  const regions: { start: number; end: number }[] = [];
  let rStart = -1;

  for (let i = 0; i < tableLineInfo.length; i++) {
    const info = tableLineInfo[i];

    // Headings rompen la región de tabla
    if (info.isHeading || info.colXs.length < 2) {
      if (rStart >= 0 && i - rStart >= 3) {
        regions.push({ start: rStart, end: i - 1 });
      }
      rStart = -1;
      continue;
    }

    if (rStart < 0) {
      rStart = i;
      continue;
    }

    // Verificar alineación con línea anterior
    const prev = tableLineInfo[i - 1];
    if (prev.colXs.length < 2 || prev.isHeading) {
      if (i - rStart >= 3) regions.push({ start: rStart, end: i - 1 });
      rStart = i;
      continue;
    }

    const minCols = Math.min(prev.colXs.length, info.colXs.length);
    let aligned = 0;
    for (let c = 0; c < minCols; c++) {
      if (Math.abs(prev.colXs[c] - info.colXs[c]) <= X_ALIGN_TOL) aligned++;
    }
    if (aligned < 2) {
      if (i - rStart >= 3) regions.push({ start: rStart, end: i - 1 });
      rStart = i;
    }
  }
  if (rStart >= 0 && tableLineInfo.length - rStart >= 3) {
    regions.push({ start: rStart, end: tableLineInfo.length - 1 });
  }

  if (regions.length === 0) return [];

  const grids: TableGrid[] = [];

  for (const region of regions) {
    const allColXs: number[][] = [];
    let maxCols = 0;
    for (let i = region.start; i <= region.end; i++) {
      const cols = lineColInfo[i].colXs;
      if (cols.length > maxCols) maxCols = cols.length;
      allColXs.push(cols);
    }

    const avgColXs: number[] = [];
    for (let c = 0; c < maxCols; c++) {
      const vals = allColXs.filter((xs) => xs.length > c).map((xs) => xs[c]);
      if (vals.length > 0) {
        avgColXs.push(vals.reduce((a, b) => a + b, 0) / vals.length);
      }
    }

    let maxX = 0;
    for (let i = region.start; i <= region.end; i++) {
      const line = lines[i];
      for (const item of line.items) {
        maxX = Math.max(maxX, item.transform[4] + item.width);
      }
    }
    avgColXs.push(maxX + 10);

    const rowYs: number[] = [];
    const firstLineH = lines[region.start].items[0]?.height ?? 12;
    rowYs.push(lines[region.start].y - firstLineH);

    for (let i = region.start; i <= region.end; i++) {
      if (i < region.end) {
        const midY = (lines[i].y + lines[i + 1].y) / 2;
        rowYs.push(midY);
      }
    }
    const lastLineH = lines[region.end].items[0]?.height ?? 12;
    rowYs.push(lines[region.end].y + lastLineH);

    if (avgColXs.length >= 2 && rowYs.length >= 3) {
      grids.push({
        rowYs,
        colXs: avgColXs,
        bounds: {
          minX: avgColXs[0] - 5,
          maxX: avgColXs[avgColXs.length - 1],
          minY: rowYs[0],
          maxY: rowYs[rowYs.length - 1],
        },
      });
    }
  }

  return grids;
}

// ─── Grid → cells assignment ────────────────────────────────────────────────

function assignItemsToTableGrid(
  items: TextItem[],
  grids: TableGrid[],
  pageHeight: number,
  pageIndex: number,
  bodyFontSize: number,
): { tableBlocks: TextBlock[]; remainingItems: TextItem[] } {
  if (grids.length === 0) {
    return { tableBlocks: [], remainingItems: items };
  }

  const tableBlocks: TextBlock[] = [];
  let remainingItems = [...items];

  for (const grid of grids) {
    const result = buildTableFromGrid(remainingItems, grid, pageHeight, pageIndex, bodyFontSize);
    if (result) {
      tableBlocks.push(result.block);
      remainingItems = result.remainingItems;
    }
  }

  return { tableBlocks, remainingItems };
}

function buildTableFromGrid(
  items: TextItem[],
  grid: TableGrid,
  pageHeight: number,
  pageIndex: number,
  bodyFontSize: number,
): { block: TextBlock; remainingItems: TextItem[] } | null {
  const { rowYs, colXs, bounds } = grid;
  const M = TABLE_CELL_MARGIN;
  const numRows = rowYs.length - 1;
  const numCols = colXs.length - 1;
  if (numRows < 1 || numCols < 1) return null;

  const tableItems: TextItem[] = [];
  const outsideItems: TextItem[] = [];

  for (const item of items) {
    const itemY = pageHeight - item.transform[5];
    const itemX = item.transform[4];

    if (
      itemX >= bounds.minX - M &&
      itemX <= bounds.maxX + M &&
      itemY >= bounds.minY - M &&
      itemY <= bounds.maxY + M
    ) {
      tableItems.push(item);
    } else {
      outsideItems.push(item);
    }
  }

  if (tableItems.length < 3) return null;

  // ── NUEVA VALIDACIÓN: Rechazar falsos positivos ──────────────────────────
  //
  // Un "decorative box" (caja decorativa alrededor de headings) tiene:
  //   - Items con font grande (>= body * 1.3) → son headings, no tabla
  //   - Solo 1 columna efectiva (aunque el grid tenga más)
  //   - Texto que parece párrafos, no datos tabulares
  //
  // Una tabla real tiene:
  //   - Múltiples columnas con datos distribuidos
  //   - Font normal (body size)
  //   - Celdas con texto corto

  // Check 1a: Si CUALQUIER item tiene font muy grande (>= body * 1.4), es un
  // decorative box alrededor de un heading/título, no una tabla real.
  // Las tablas reales tienen headers con font normal (~body) o ligeramente mayor.
  const hasVeryLargeFont = tableItems.some((it) => it.fontSize > bodyFontSize * 1.4);
  if (hasVeryLargeFont) {
    return null; // Contiene headings → es caja decorativa
  }

  // Check 1b: Si muchos items tienen font grande, también rechazar
  const largeFont = tableItems.filter((it) => it.fontSize > bodyFontSize * 1.15);
  if (largeFont.length > tableItems.length * 0.25) {
    return null; // Demasiado texto heading-like para ser tabla
  }

  // Check 2: Verificar que hay items en al menos 2 columnas distintas
  const colDistribution = new Set<number>();
  for (const item of tableItems) {
    const itemX = item.transform[4];
    for (let c = 0; c < numCols; c++) {
      if (itemX >= colXs[c] - M && (c === numCols - 1 || itemX < colXs[c + 1] - M)) {
        colDistribution.add(c);
        break;
      }
    }
  }
  if (colDistribution.size < 2) {
    return null; // Solo una columna → no es tabla
  }

  // Build cells
  const cellItems: TextItem[][][] = Array.from({ length: numRows }, () =>
    Array.from({ length: numCols }, () => [] as TextItem[]),
  );

  for (const item of tableItems) {
    const itemY = pageHeight - item.transform[5];
    const itemX = item.transform[4];

    let row = -1;
    for (let r = 0; r < numRows; r++) {
      if (itemY >= rowYs[r] - M && itemY < rowYs[r + 1] + M) {
        row = r;
        break;
      }
    }

    let col = -1;
    for (let c = 0; c < numCols; c++) {
      if (itemX >= colXs[c] - M && (c === numCols - 1 || itemX < colXs[c + 1] - M)) {
        col = c;
        break;
      }
    }

    if (row >= 0 && col >= 0) {
      cellItems[row][col].push(item);
    }
  }

  // Sort y concatenar texto por celda
  const cells: string[][] = cellItems.map((rowItems) =>
    rowItems.map((citems) => {
      citems.sort((a, b) => {
        const ya = pageHeight - a.transform[5];
        const yb = pageHeight - b.transform[5];
        if (Math.abs(ya - yb) > Y_TOLERANCE) return ya - yb;
        return a.transform[4] - b.transform[4];
      });
      return citems.map((it) => it.str).join(' ').trim();
    }),
  );

  // Validar filas con contenido
  const filledRows = cells.filter((row) => row.some((c) => c.length > 0)).length;
  if (filledRows < 2) return null;

  // ── Check 3: Verificar que las filas tienen contenido en múltiples columnas ─
  const multiColRows = cells.filter(
    (row) => row.filter((c) => c.length > 0).length >= 2,
  ).length;
  if (multiColRows < filledRows * 0.5) {
    return null; // Mayoría de filas con solo 1 celda → no es tabla
  }

  // Detectar header
  const firstRowText = cells[0].map((c) => c.trim()).filter(Boolean);
  const hasHeader = firstRowText.length >= 2 && firstRowText.every((t) => t.length < 60);

  // Formatear para TTS — lectura más natural
  const parts: string[] = [];

  if (hasHeader) {
    const headers = cells[0].map((c) => c.trim());

    parts.push(`Tabla con ${numCols} columnas: ${firstRowText.join(', ')}.`);

    for (let r = 1; r < numRows; r++) {
      const rowCells = cells[r].map((c) => c.trim());
      if (rowCells.every((c) => !c)) continue;

      // Formato: "Primera celda. Header2: valor2. Header3: valor3."
      const cellParts: string[] = [];
      for (let c = 0; c < numCols; c++) {
        const cellText = rowCells[c];
        if (!cellText) continue;

        if (c === 0) {
          cellParts.push(cellText);
        } else if (headers[c]) {
          cellParts.push(`${headers[c]}: ${cellText}`);
        } else {
          cellParts.push(cellText);
        }
      }
      if (cellParts.length > 0) {
        parts.push(cellParts.join('. ') + '.');
      }
    }
  } else {
    parts.push('Tabla, continuación.');
    for (let r = 0; r < numRows; r++) {
      const rowCells = cells[r].map((c) => c.trim());
      if (rowCells.every((c) => !c)) continue;
      parts.push(rowCells.filter(Boolean).join('. ') + '.');
    }
  }

  return {
    block: {
      text: parts.join('\n'),
      pageIndex,
      type: 'table' as const,
      yPosition: bounds.minY / pageHeight,
    },
    remainingItems: outsideItems,
  };
}

// ─── Paragraph grouping (font-aware) ───────────────────────────────────────

function groupIntoParagraphs(
  lines: LineGroup[],
  pageHeight: number,
  pageIndex: number,
  bodyFontSize: number,
): TextBlock[] {
  const blocks: TextBlock[] = [];
  let currentText = '';
  let currentType: TextBlock['type'] = 'paragraph';
  let blockStartY = 0;

  const flushBlock = () => {
    if (currentText.trim()) {
      blocks.push({
        text: currentText.trim(),
        pageIndex,
        type: currentType,
        yPosition: blockStartY / pageHeight,
      });
    }
    currentText = '';
    currentType = 'paragraph';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineText = line.items.map((it) => it.str).join('').trim();
    if (!lineText) continue;

    // ── Detectar tipo de línea ────────────────────────────────────────────
    const isHeading = detectHeadingFromLine(line, bodyFontSize);
    const isList = /^[-•●◦]\s|^[a-z][\.\)]\s/.test(lineText);
    const isMath = detectMathLine(lineText);

    // ── Detectar separación de párrafo ───────────────────────────────────
    let isNewBlock = false;

    if (i > 0) {
      const gap = Math.abs(line.y - lines[i - 1].y);

      // Gap grande → nuevo párrafo
      if (gap > PARAGRAPH_GAP) isNewBlock = true;

      // Cambio de heading ↔ no-heading → nuevo bloque
      const prevIsHeading = detectHeadingFromLine(lines[i - 1], bodyFontSize);
      if (isHeading !== prevIsHeading) isNewBlock = true;

      // Cambio de font size significativo → nuevo bloque
      if (Math.abs(line.dominantFontSize - lines[i - 1].dominantFontSize) > 1.5) {
        isNewBlock = true;
      }
    }

    if (isNewBlock) {
      flushBlock();
      blockStartY = line.y;
    } else if (i === 0) {
      blockStartY = line.y;
    }

    // Asignar tipo
    if (isHeading) {
      currentType = 'heading';
    } else if (isMath) {
      currentType = 'math';
    } else if (isList) {
      currentType = 'list';
    }

    // Acumular texto
    currentText +=
      currentText && !currentText.endsWith('\n') ? ' ' + lineText : lineText;
  }

  flushBlock();
  return blocks;
}

/**
 * Detecta si una línea es heading basándose en:
 * 1. Font size > body * 1.15 y bold
 * 2. Font size > body * 1.3 (aunque no sea bold)
 * 3. Línea corta (<80 chars), bold, y empieza con número (ej: "1.2. Sección")
 */
function detectHeadingFromLine(line: LineGroup, bodyFontSize: number): boolean {
  const lineText = line.items.map((it) => it.str).join('').trim();
  if (!lineText || lineText.length > 120) return false;

  // Font significativamente más grande
  if (line.dominantFontSize > bodyFontSize * 1.3) return true;
  if (line.dominantFontSize > bodyFontSize * 1.15 && line.isBold) return true;

  // Bold + corta + empieza con patrón de sección
  if (
    line.isBold &&
    lineText.length < 80 &&
    /^\d+[\.\)]/.test(lineText)
  ) {
    return true;
  }

  // Bold + corta + toda mayúsculas
  if (line.isBold && lineText.length < 80 && lineText === lineText.toUpperCase() && lineText.length > 3) {
    return true;
  }

  return false;
}

function detectMathLine(text: string): boolean {
  const trimmed = text.trim();
  const mathChars = (trimmed.match(new RegExp(MATH_CHAR_REGEX, 'g')) || []).length;
  return mathChars / trimmed.length > 0.15;
}
