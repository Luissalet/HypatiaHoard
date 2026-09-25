/**
 * resourceFromDB.ts
 * 
 * Funciones auxiliares para cargar recursos desde IndexedDB
 */

import { db } from './db';

interface ResourceFile {
  name: string;
  path: string;
  type: string; // extension
}

interface SubCategory {
  name: string;
  files: ResourceFile[];
}

interface ResourceCategory {
  name: string;
  slug: string;
  files: ResourceFile[];
  subcategories?: SubCategory[];
}

/**
 * Carga los recursos de una categoría desde IndexedDB
 */
export async function loadCategoryFromDB(
  subjectId: string,
  categorySlug: string
): Promise<{ files: ResourceFile[]; subcategories?: SubCategory[] }> {
  const records = await db.pdfResources
    .where('subjectId')
    .equals(subjectId)
    .toArray();

  // Filtrar por categoría
  const categoryRecords = records.filter((r) => 
    r.filename.startsWith(`${categorySlug}/`)
  );

  if (categoryRecords.length === 0) {
    return { files: [] };
  }

  const files: ResourceFile[] = [];
  const subcategoriesMap = new Map<string, ResourceFile[]>();

  for (const record of categoryRecords) {
    // Remover el prefijo de la categoría: "Examenes/archivo.pdf" -> "archivo.pdf"
    const relativePath = record.filename.substring(categorySlug.length + 1);
    const parts = relativePath.split('/');
    const filename = parts[parts.length - 1];
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';

    const fileEntry: ResourceFile = {
      name: filename,
      path: relativePath,
      type: ext,
    };

    if (parts.length === 1) {
      // Archivo en la raíz de la categoría
      files.push(fileEntry);
    } else {
      // Archivo en subdirectorio
      const subcategoryName = parts[0];
      if (!subcategoriesMap.has(subcategoryName)) {
        subcategoriesMap.set(subcategoryName, []);
      }
      subcategoriesMap.get(subcategoryName)!.push(fileEntry);
    }
  }

  const subcategories: SubCategory[] = Array.from(subcategoriesMap.entries()).map(
    ([name, files]) => ({ name, files })
  );

  return {
    files,
    subcategories: subcategories.length > 0 ? subcategories : undefined,
  };
}

/**
 * Obtiene la URL blob de un recurso desde IndexedDB
 */
export async function getResourceBlobUrl(
  subjectId: string,
  filename: string
): Promise<string | null> {
  const record = await db.pdfResources
    .where('subjectId')
    .equals(subjectId)
    .filter((r) => r.filename === filename)
    .first();

  if (!record) return null;
  return URL.createObjectURL(record.blob);
}
