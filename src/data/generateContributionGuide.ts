import { db } from './db';
import { slugify } from '@/domain/normalize';

/**
 * Generates a personalized GUIA_CONTRIBUTION_PACKS.md based on the user's
 * actual subjects and topics stored in IndexedDB.
 */
export async function generateContributionGuide(): Promise<string> {
  const subjects = await db.subjects.toArray();
  const allTopics = await db.topics.toArray();

  // Build subject table rows
  const subjectTableRows = subjects
    .map((s) => `| ${s.name} | \`${slugify(s.name)}\` |`)
    .join('\n');

  // Build subject keys list for ChatGPT prompt section
  const subjectKeysList = subjects
    .map((s) => `  - ${slugify(s.name)}`)
    .join('\n');

  // Build annexo sections
  const annexoSections = subjects
    .map((s) => {
      const topics = allTopics
        .filter((t) => t.subjectId === s.id)
        .sort((a, b) => a.order - b.order);

      const topicRows = topics
        .map((t, i) => `| ${i + 1} | ${t.title} | \`${slugify(t.title)}\` |`)
        .join('\n');

      return `### ${s.name}

**\`subjectKey\`**: \`${slugify(s.name)}\`
**\`subjectName\`**: \`"${s.name}"\`

| # | Título del Tema | \`topicKey\` |
|---|-----------------|------------|
${topicRows}`;
    })
    .join('\n\n---\n\n');

  return `# Guía para crear Contribution Packs

## ¿Qué es un Contribution Pack?

Un **contribution pack** es un archivo JSON que contiene preguntas creadas por un contribuidor para compartir con el banco global de preguntas. Este formato permite que varios compañeros aporten preguntas sin compartir la misma base de datos.

---

## 🚨 REGLA CRÍTICA — SLUGS EXACTOS OBLIGATORIOS

> **Para ChatGPT y cualquier herramienta que genere contribution packs:**
>
> Los valores de \`subjectKey\` y \`topicKey\` **NO se inventan, NO se generan, NO se parafrasean**.
> Deben copiarse **literalmente** del **Anexo de Temarios** al final de esta guía.
>
> **Lista completa de \`subjectKey\` válidos — solo estos ${subjects.length}, sin variaciones:**
>
> | Asignatura | \`subjectKey\` exacto |
> |---|---|
${subjects.map((s) => `> | ${s.name} | \`${slugify(s.name)}\` |`).join('\n')}
>
> ❌ **INCORRECTO**: Cualquier slug que no aparezca exactamente en la tabla de arriba o en el Anexo.
> ✅ **CORRECTO**: Copia textualmente de la tabla de arriba o del Anexo al final de esta guía.
>
> Lo mismo aplica para \`topicKey\`: cada tema tiene un slug único definido en el Anexo. Si el slug que estás usando no aparece exactamente en el Anexo, está mal.

---

## Estructura completa del Contribution Pack

\`\`\`json
{
  "version": 1,
  "kind": "contribution",
  "packId": "uuid-único-del-pack",
  "createdBy": "Nombre del Contribuidor",
  "exportedAt": "2026-02-18T12:00:00.000Z",
  "targets": [
    {
      "subjectKey": "slug-de-la-asignatura",
      "subjectName": "Nombre Completo de la Asignatura",
      "topics": [
        {
          "topicKey": "slug-del-tema",
          "topicTitle": "Título Completo del Tema"
        }
      ]
    }
  ],
  "questions": [
    {
      "id": "uuid-de-la-pregunta",
      "subjectKey": "slug-de-la-asignatura",
      "topicKey": "slug-del-tema",
      "type": "TEST",
      "prompt": "Texto de la pregunta",
      "origin": "test",
      "difficulty": 3,
      "options": [
        { "id": "opt1", "text": "Opción A" },
        { "id": "opt2", "text": "Opción B" },
        { "id": "opt3", "text": "Opción C" },
        { "id": "opt4", "text": "Opción D" }
      ],
      "correctOptionIds": ["opt1"],
      "explanation": "Explicación de la respuesta correcta (opcional)",
      "tags": ["etiqueta1", "etiqueta2"],
      "createdBy": "Nombre del Contribuidor",
      "contentHash": "sha256:hash-del-contenido"
    }
  ]
}
\`\`\`

---

## Campos obligatorios y opcionales

### Campos del pack

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| \`version\` | number | ✅ | Siempre \`1\` |
| \`kind\` | string | ✅ | Siempre \`"contribution"\` |
| \`packId\` | string | ✅ | UUID único del pack |
| \`createdBy\` | string | ✅ | Nombre/alias del contribuidor |
| \`exportedAt\` | string | ✅ | Fecha ISO de exportación |
| \`targets\` | array | ✅ | Asignaturas y temas incluidos |
| \`questions\` | array | ✅ | Preguntas del pack |
| \`questionImages\` | object | ⭕ | Mapa de imágenes inline \`{ "uuid.ext": "base64..." }\` |

### Campos de cada pregunta

| Campo | Tipo | Obligatorio | Descripción | Valores posibles |
|-------|------|-------------|-------------|------------------|
| \`id\` | string | ✅ | UUID único | UUID v4 |
| \`subjectKey\` | string | ✅ | Slug de la asignatura — **del Anexo** | ver Anexo |
| \`topicKey\` | string | ✅ | Slug del tema — **del Anexo** | ver Anexo |
| \`type\` | string | ✅ | Tipo de pregunta | \`"TEST"\`, \`"DESARROLLO"\`, \`"COMPLETAR"\`, \`"PRACTICO"\` |
| \`prompt\` | string | ✅ | Enunciado de la pregunta | Markdown + LaTeX |
| \`origin\` | string | ⭕ | **Origen de la pregunta** | \`"test"\`, \`"examen_anterior"\`, \`"clase"\`, \`"alumno"\` |
| \`difficulty\` | number | ⭕ | Dificultad (1-5) | \`1\`, \`2\`, \`3\`, \`4\`, \`5\` |
| \`explanation\` | string | ⭕ | Explicación de la respuesta | Markdown + LaTeX |
| \`tags\` | array | ⭕ | Etiquetas | \`["etiqueta1", "etiqueta2"]\` |
| \`createdBy\` | string | ⭕ | Autor de la pregunta | Nombre/alias |
| \`contentHash\` | string | ⭕ | Hash para deduplicación | \`"sha256:..."\` |
| \`topicIds\` | array | ⭕ | **Temas adicionales** (multi-tema) | slugs del Anexo |

---

### ⚠️ PREGUNTAS MULTI-TEMA

Una pregunta puede abarcar **varios temas a la vez**.

**Campo \`topicKey\`** (obligatorio): El tema PRINCIPAL de la pregunta
**Campo \`topicIds\`** (opcional): Array con TODOS los temas (incluido el principal)

**Reglas:**
- Si una pregunta tiene 1 solo tema: usa \`topicKey\` únicamente, NO uses \`topicIds\`
- Si una pregunta tiene 2+ temas: usa \`topicKey\` para el principal Y \`topicIds\` con todos
- El tema de \`topicKey\` DEBE estar incluido en \`topicIds\` si este campo existe
- Los slugs en \`topicIds\` también deben venir del Anexo

---

### Campos específicos por tipo de pregunta

#### Para preguntas tipo TEST:
| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| \`options\` | array | ✅ | Array de objetos \`{id, text}\` |
| \`correctOptionIds\` | array | ✅ | IDs de opciones correctas |

#### Para preguntas tipo DESARROLLO o PRACTICO:
| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| \`modelAnswer\` | string | ⭕ | Respuesta modelo (Markdown + LaTeX) |
| \`keywords\` | array | ⭕ | Palabras clave esperadas |
| \`numericAnswer\` | string | ⭕ | Respuesta numérica (solo PRACTICO) |

#### Para preguntas tipo COMPLETAR:
| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| \`clozeText\` | string | ✅ | Texto con huecos \`{{respuesta}}\` |
| \`blanks\` | array | ✅ | Array de objetos \`{id, accepted[]}\` |

---

## ⚠️ CAMPO ORIGIN

El campo \`origin\` especifica de dónde fue extraída la pregunta. Es opcional pero muy recomendado.

| Valor | Descripción |
|-------|-------------|
| \`"test"\` | Pregunta de un test de práctica |
| \`"examen_anterior"\` | Pregunta de un examen oficial previo |
| \`"clase"\` | Pregunta planteada en clase |
| \`"alumno"\` | Pregunta creada por un alumno |

---

## ✍️ Markdown y LaTeX en los textos

Todos los campos de texto (\`prompt\`, \`modelAnswer\`, \`explanation\`, \`options[].text\`, \`clozeText\`) soportan **Markdown** completo y **fórmulas matemáticas LaTeX** renderizadas con KaTeX.

Se aceptan **cuatro estilos de delimitadores**, todos equivalentes:

| Tipo | Inline | Bloque (display) |
|------|--------|-----------------|
| Estilo pandoc/KaTeX | \`$...$\` | \`$$...$$\` |
| Estilo LaTeX estándar | \`\\(...\\)\` | \`\\[...\\]\` |

---

## Proceso recomendado para crear contribution packs con ChatGPT

1. **Exporta el banco actual** en formato compacto (Ajustes > Exportar banco compacto) para evitar duplicados
2. **Identifica el tema exacto** en el Anexo de Temarios al final de esta guía y copia el slug
3. **Usa este prompt con ChatGPT**:

\`\`\`
Voy a crear un contribution pack de preguntas para mi banco de estudio.
Lee esta guía completa: GUIA_CONTRIBUTION_PACKS.md

══════════════════════════════════════════
🚨 SLUGS OBLIGATORIOS — NO INVENTAR
══════════════════════════════════════════
Los valores de "subjectKey" y "topicKey" son FIJOS e INMUTABLES.
NO los generes, NO los parafrasees, NO los simplifiques.
Cópialos LITERALMENTE de la sección "Anexo: Índices de Temario" de la guía.

subjectKey válidos (ÚNICAMENTE estos ${subjects.length}):
${subjectKeysList}

topicKey del tema a trabajar (copiado del Anexo):
  → [PEGA AQUÍ EL topicKey EXACTO DEL TEMA]

══════════════════════════════════════════

TAREA:
Crea 20 preguntas tipo TEST para:
  - Asignatura: "[NOMBRE ASIGNATURA]"
    subjectKey: "[SLUG ASIGNATURA]"
  - Tema: "[NOMBRE TEMA]"
    topicKey: "[SLUG TEMA]"

REQUISITOS de cada pregunta:
1. Campo "origin" obligatorio: "test" | "examen_anterior" | "clase" | "alumno"
   (si creas preguntas desde cero usa "alumno")
2. difficulty entre 1 y 5
3. explanation siempre que sea posible
4. Texto en Markdown. Usa LaTeX con delimitadores $...$ (inline) y $$...$$ (bloque)
   para fórmulas matemáticas. Matrices con \\begin{bmatrix}...\\end{bmatrix}.
5. NO incluyas el campo "questionImages" — las imágenes se añaden manualmente

Banco actual (para evitar duplicados):
[PEGA AQUÍ EL JSON DEL BANCO COMPACTO EXPORTADO]

VERIFICACIÓN FINAL antes de responder:
✓ subjectKey copiado exactamente del Anexo
✓ topicKey copiado exactamente del Anexo
✓ Todas las preguntas tienen "origin"
✓ No hay duplicados con el banco actual
✓ JSON válido (sin comentarios //)
✓ difficulty en todas las preguntas
✓ explanation incluida cuando sea posible
✓ Fórmulas con LaTeX donde corresponda
\`\`\`

4. **Revisa el JSON generado**: verifica que \`subjectKey\` y \`topicKey\` coincidan exactamente con el Anexo
5. **Importa el pack** en Ajustes > Importar contribuciones para validar que no hay errores

---

## Validación y errores comunes

### ❌ Error: Slug inventado
Los slugs deben copiarse **literalmente** del Anexo. Cualquier variación será rechazada durante la importación.

### ❌ Error: Falta el campo origin
Aunque es técnicamente opcional, siempre es recomendable incluirlo.

### Otros errores comunes:
1. **Slugs incorrectos**: \`subjectKey\` y \`topicKey\` deben coincidir exactamente con el Anexo
2. **UUIDs duplicados**: cada pregunta debe tener un UUID único
3. **Tipo de pregunta incorrecto**: solo \`"TEST"\`, \`"DESARROLLO"\`, \`"COMPLETAR"\` o \`"PRACTICO"\`
4. **Opciones sin ID**: en TEST, cada opción necesita un \`id\` único
5. **\`correctOptionIds\` vacío**: en TEST debe haber al menos una opción correcta
6. **Comentarios \`//\` en JSON**: JSON no admite comentarios, elimínalos antes de importar

---

## Anexo: Índices de Temario

> 🚨 **Esta es la fuente de verdad para \`subjectKey\` y \`topicKey\`.**
> Copia los slugs literalmente. No los modifiques ni abrevies.

---

${annexoSections}

---

## Soporte

Si tienes dudas o encuentras errores:
1. Verifica el slug en el Anexo de esta guía
2. Valida el JSON en https://jsonlint.com/
3. Importa el pack en la app para ver mensajes de error detallados
`;
}

/**
 * Downloads the generated guide as a .md file
 */
export async function downloadContributionGuide(): Promise<void> {
  const content = await generateContributionGuide();
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `GUIA_CONTRIBUTION_PACKS.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
