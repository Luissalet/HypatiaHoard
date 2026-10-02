/**
 * studentPrivacy.ts — los datos de alumnos (nombres, respuestas, notas) son LOCALES.
 *
 * Viven en las tablas del rol Profesor (abajo) y en el servidor local de Hypatia.
 * Nunca salen en: la copia de Gist, el banco global, los contribution packs, los
 * paquetes del marketplace, la exportación de exámenes/conceptos ni la exportación
 * compacta. Cada una de esas exportaciones pasa por `guardPublicExport`, que quita
 * esas tablas si alguien las añadiera y falla si queda cualquier rastro de alumno.
 * Sin dependencias (se prueba con node).
 */

/** Tablas Dexie del rol Profesor: nunca se exportan fuera de este dispositivo. */
export const STUDENT_DATA_TABLES = [
  'teacherClasses',
  'teacherStudents',
  'teacherExams',
  'rubrics',
  'gradingBatches',
  'submissions',
  'gradingProposals',
  'teacherSettings',
] as const;

/** Campos que solo existen en datos de alumnos. */
const STUDENT_FIELDS = ['studentId', 'studentIds', 'submissionId', 'batchId', 'classId'];

const FORBIDDEN = new Set<string>([...STUDENT_DATA_TABLES, ...STUDENT_FIELDS]);

export class StudentDataLeak extends Error {
  constructor(public where: string, public paths: string[]) {
    super(`La exportación «${where}» contiene datos de alumnos (${paths.slice(0, 3).join(', ')}); no se ha exportado.`);
    this.name = 'StudentDataLeak';
  }
}

/** Rutas (a.b[2].c) de los campos de alumnos que haya en `payload`. */
export function findStudentData(payload: unknown, maxDepth = 8): string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > maxDepth || value === null || typeof value !== 'object') return;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (FORBIDDEN.has(key)) found.push(here);
      walk(v, here, depth + 1);
    }
  };
  walk(payload, '', 0);
  return found;
}

/** Quita las tablas del rol Profesor del nivel superior de una exportación. */
export function stripStudentData<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const copy = { ...(payload as Record<string, unknown>) };
  for (const table of STUDENT_DATA_TABLES) delete copy[table];
  return copy as T;
}

/** La única puerta de salida de las exportaciones públicas o sincronizadas. */
export function guardPublicExport<T>(payload: T, where: string): T {
  const clean = stripStudentData(payload);
  const leaks = findStudentData(clean);
  if (leaks.length) throw new StudentDataLeak(where, leaks);
  return clean;
}
