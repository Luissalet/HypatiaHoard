/**
 * resourceLoader.ts
 *
 * Carga assets estáticos del directorio resources/ del repo:
 *   resources/[slug-asignatura]/extra_info.json   → SubjectExtraInfo
 *   resources/[slug-asignatura]/Temas/index.json  → string[] (nombres de PDFs)
 *   resources/[slug-asignatura]/Temas/[file].pdf  → URL directa
 *
 * El slug se genera igual que en normalize.ts (slugify) para que el directorio
 * coincida con el nombre de asignatura usado en contribution packs.
 */

import type { SubjectExtraInfo } from '@/domain/models';

export interface PdfMapping {
  topicTitle: string;
  pdf: string;
}

/** Cache en memoria para evitar fetches repetidos en la misma sesión. */
const extraInfoCache = new Map<string, SubjectExtraInfo | null>();
const pdfListCache = new Map<string, string[]>();
const pdfMappingCache = new Map<string, PdfMapping[]>();

/**
 * Convierte un nombre de asignatura en slug de directorio.
 * Debe coincidir exactamente con la función slugify de normalize.ts.
 */
function toSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Resuelve un path dentro de resources/ como URL absoluta correcta para la SPA.
 *
 * Problema: fetch('./resources/...') desde la página /subject/:id resuelve la URL
 * como /subject/resources/... → 404, porque ./ es relativo al pathname actual.
 *
 * Solución: anclar siempre a la raíz del sitio usando import.meta.env.BASE_URL.
 *   - Dev (Vite siempre usa BASE_URL='/'): /resources/...
 *   - Build con base:'/':                  /resources/...
 *   - Build con base:'/study-app/':        /study-app/resources/...
 *   - Build con base:'./':                 /resources/... (asume despliegue en raíz)
 *
 * Usa (import.meta as any).env para evitar necesitar los tipos de Vite en tsconfig.
 */
export function resourcesUrl(relativePath: string): string {
  // (import.meta as any).env.BASE_URL es inyectado por Vite en tiempo de build/dev.
  // En test u otros entornos donde no existe, cae al fallback '/'.
  const base: string = ((import.meta as Record<string, any>).env?.BASE_URL) ?? '/';
  // Si base es relativa ('./'), anclar al origen (equivale a '/')
  if (!base || base === './') return `/${relativePath}`;
  return `${base}${relativePath}`;
}

/**
 * Carga el extra_info.json de una asignatura.
 * Devuelve null si no existe o hay error.
 */
export async function loadSubjectExtraInfo(subjectName: string): Promise<SubjectExtraInfo | null> {
  const slug = toSlug(subjectName);
  if (extraInfoCache.has(slug)) return extraInfoCache.get(slug)!;

  try {
    const res = await fetch(resourcesUrl(`resources/${slug}/extra_info.json`), { cache: 'no-cache' });
    if (!res.ok) {
      extraInfoCache.set(slug, null);
      return null;
    }
    const data: SubjectExtraInfo = await res.json();
    extraInfoCache.set(slug, data);
    return data;
  } catch {
    extraInfoCache.set(slug, null);
    return null;
  }
}

/**
 * Invalida la caché de una asignatura (útil tras modificar los ficheros).
 */
export function invalidateExtraInfoCache(subjectName: string): void {
  const slug = toSlug(subjectName);
  extraInfoCache.delete(slug);
  pdfListCache.delete(slug);
  pdfMappingCache.delete(slug);
}

/**
 * Carga el mapeo { topicTitle, pdf } desde resources/[slug]/Temas/index.json.
 * Soporta el formato nuevo ({ topicTitle, pdf }[]) y el antiguo (string[]).
 * Devuelve [] si no existe o hay error.
 */
export async function loadPdfMapping(subjectName: string): Promise<PdfMapping[]> {
  const slug = toSlug(subjectName);
  if (pdfMappingCache.has(slug)) return pdfMappingCache.get(slug)!;

  try {
    const res = await fetch(resourcesUrl(`resources/${slug}/Temas/index.json`), { cache: 'no-cache' });
    if (res.ok) {
      const raw = await res.json();
      let mapping: PdfMapping[];
      if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
        mapping = (raw as string[]).map(pdf => ({ topicTitle: '', pdf }));
      } else {
        mapping = raw as PdfMapping[];
      }
      pdfMappingCache.set(slug, mapping);
      return mapping;
    }
  } catch {
    // fall through
  }

  // Fallback: lista en extra_info.pdfs (sin topicTitle)
  const info = await loadSubjectExtraInfo(subjectName);
  const mapping = (info?.pdfs ?? []).map(pdf => ({ topicTitle: '', pdf }));
  pdfMappingCache.set(slug, mapping);
  return mapping;
}

/**
 * Lista de nombres de PDFs. Derivada de loadPdfMapping.
 * @deprecated Usa loadPdfMapping para obtener también el topicTitle.
 */
export async function loadPdfList(subjectName: string): Promise<string[]> {
  const slug = toSlug(subjectName);
  if (pdfListCache.has(slug)) return pdfListCache.get(slug)!;

  const mapping = await loadPdfMapping(subjectName);
  const list = mapping.map(e => e.pdf);
  pdfListCache.set(slug, list);
  return list;
}

/**
 * Devuelve la URL de un PDF (relativa a la raíz del sitio).
 */
export function getPdfUrl(subjectName: string, filename: string): string {
  const slug = toSlug(subjectName);
  return resourcesUrl(`resources/${slug}/Temas/${encodeURIComponent(filename)}`);
}