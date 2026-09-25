# Guía para crear Contribution Packs

## ¿Qué es un Contribution Pack?

Un **contribution pack** es un archivo JSON que contiene preguntas creadas por un contribuidor para compartir con el banco global de preguntas. Este formato permite que varios compañeros aporten preguntas sin compartir la misma base de datos.

---

## 🚨 REGLA CRÍTICA — SLUGS EXACTOS OBLIGATORIOS

> **Para ChatGPT y cualquier herramienta que genere contribution packs:**
>
> Los valores de `subjectKey` y `topicKey` **NO se inventan, NO se generan, NO se parafrasean**.  
> Deben copiarse **literalmente** del **Anexo de Temarios** al final de esta guía.
>
> **Lista completa de `subjectKey` válidos — solo estos 5, sin variaciones:**
>
> | Asignatura | `subjectKey` exacto |
> |---|---|
> | Procesamiento del Lenguaje Natural | `procesamiento-del-lenguaje-natural` |
> | Visión Artificial | `vision-artificial` |
> | Investigación y Gestión de Proyectos en IA | `investigacion-y-gestion-de-proyectos-en-inteligencia-artificial` |
> | Razonamiento y Planificación Automática | `razonamiento-y-planificacion-automatica` |
> | Técnicas de Aprendizaje Automático | `tecnicas-de-aprendizaje-automatico` |
>
> ❌ **INCORRECTO**: `"ia-razonamiento-y-planificacion"`, `"razonamiento-planificacion"`, `"tecnicas-aprendizaje"`  
> ✅ **CORRECTO**: Copia textualmente de la tabla de arriba o del Anexo al final de esta guía.
>
> Lo mismo aplica para `topicKey`: cada tema tiene un slug único definido en el Anexo. Si el slug que estás usando no aparece exactamente en el Anexo, está mal.

---

## Estructura completa del Contribution Pack

```json
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
```

---

## Campos obligatorios y opcionales

### Campos del pack

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `version` | number | ✅ | Siempre `1` |
| `kind` | string | ✅ | Siempre `"contribution"` |
| `packId` | string | ✅ | UUID único del pack |
| `createdBy` | string | ✅ | Nombre/alias del contribuidor |
| `exportedAt` | string | ✅ | Fecha ISO de exportación |
| `targets` | array | ✅ | Asignaturas y temas incluidos |
| `questions` | array | ✅ | Preguntas del pack |
| `questionImages` | object | ⭕ | Mapa de imágenes inline `{ "uuid.ext": "base64..." }` |

### Campos de cada pregunta

| Campo | Tipo | Obligatorio | Descripción | Valores posibles |
|-------|------|-------------|-------------|------------------|
| `id` | string | ✅ | UUID único | UUID v4 |
| `subjectKey` | string | ✅ | Slug de la asignatura — **del Anexo** | ver Anexo |
| `topicKey` | string | ✅ | Slug del tema — **del Anexo** | ver Anexo |
| `type` | string | ✅ | Tipo de pregunta | `"TEST"`, `"DESARROLLO"`, `"COMPLETAR"`, `"PRACTICO"` |
| `prompt` | string | ✅ | Enunciado de la pregunta | Markdown + LaTeX |
| `origin` | string | ⭕ | **Origen de la pregunta** | `"test"`, `"examen_anterior"`, `"clase"`, `"alumno"` |
| `difficulty` | number | ⭕ | Dificultad (1-5) | `1`, `2`, `3`, `4`, `5` |
| `explanation` | string | ⭕ | Explicación de la respuesta | Markdown + LaTeX |
| `tags` | array | ⭕ | Etiquetas | `["etiqueta1", "etiqueta2"]` |
| `createdBy` | string | ⭕ | Autor de la pregunta | Nombre/alias |
| `contentHash` | string | ⭕ | Hash para deduplicación | `"sha256:..."` |
| `topicIds` | array | ⭕ | **Temas adicionales** (multi-tema) | slugs del Anexo |

---

### ⚠️ PREGUNTAS MULTI-TEMA

Una pregunta puede abarcar **varios temas a la vez**.

Esto es común en:
- Preguntas tipo **DESARROLLO** que integran conocimientos de múltiples temas
- Preguntas **PRACTICO** que aplican conceptos de diferentes unidades
- Preguntas que relacionan temas (ej: "Compara el algoritmo A del tema 2 con el B del tema 5")

**Campo `topicKey`** (obligatorio): El tema PRINCIPAL de la pregunta  
**Campo `topicIds`** (opcional): Array con TODOS los temas (incluido el principal)

```json
{
  "topicKey": "tema-5-busqueda-informada",
  "topicIds": [
    "tema-4-busqueda-no-informada",
    "tema-5-busqueda-informada"
  ]
}
```

**Reglas:**
- Si una pregunta tiene 1 solo tema: usa `topicKey` únicamente, NO uses `topicIds`
- Si una pregunta tiene 2+ temas: usa `topicKey` para el principal Y `topicIds` con todos
- El tema de `topicKey` DEBE estar incluido en `topicIds` si este campo existe
- Los slugs en `topicIds` también deben venir del Anexo

---

### Campos específicos por tipo de pregunta

#### Para preguntas tipo TEST:
| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `options` | array | ✅ | Array de objetos `{id, text}` |
| `correctOptionIds` | array | ✅ | IDs de opciones correctas |

#### Para preguntas tipo DESARROLLO o PRACTICO:
| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `modelAnswer` | string | ⭕ | Respuesta modelo (Markdown + LaTeX) |
| `keywords` | array | ⭕ | Palabras clave esperadas |
| `numericAnswer` | string | ⭕ | Respuesta numérica (solo PRACTICO) |

#### Para preguntas tipo COMPLETAR:
| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `clozeText` | string | ✅ | Texto con huecos `{{respuesta}}` |
| `blanks` | array | ✅ | Array de objetos `{id, accepted[]}` |

---

## ⚠️ CAMPO ORIGIN

El campo `origin` especifica de dónde fue extraída la pregunta. Es opcional pero muy recomendado.

| Valor | Descripción |
|-------|-------------|
| `"test"` | Pregunta de un test de práctica |
| `"examen_anterior"` | Pregunta de un examen oficial previo |
| `"clase"` | Pregunta planteada en clase |
| `"alumno"` | Pregunta creada por un alumno |

---

## ✍️ Markdown y LaTeX en los textos

Todos los campos de texto (`prompt`, `modelAnswer`, `explanation`, `options[].text`, `clozeText`) soportan **Markdown** completo y **fórmulas matemáticas LaTeX** renderizadas con KaTeX.

### Markdown

```markdown
**negrita**, *cursiva*, `código`

- listas
- con viñetas

| col A | col B |
|-------|-------|
| val 1 | val 2 |
```

### Fórmulas matemáticas (LaTeX / KaTeX)

Se aceptan **cuatro estilos de delimitadores**, todos equivalentes:

| Tipo | Inline | Bloque (display) |
|------|--------|-----------------|
| Estilo pandoc/KaTeX | `$...$` | `$$...$$` |
| Estilo LaTeX estándar | `\(...\)` | `\[...\]` |

La app normaliza automáticamente todos los delimitadores antes de renderizar, así que puedes usar el estilo que prefieras o el que genere ChatGPT.

**Ejemplos de uso en preguntas:**

```markdown
En el contexto del filtrado espacial, se analiza el siguiente *kernel* $h$:

$$
h = \begin{bmatrix}
-1 & -1 & -1 \\
-1 & (\alpha+8) & -1 \\
-1 & -1 & -1
\end{bmatrix}, \qquad \alpha \ge 0
$$

(a) ¿Qué tipo de filtro es $h$?
```

```markdown
La función de coste en regresión logística es:

$$J(\theta) = -\frac{1}{m}\sum_{i=1}^{m}\left[y^{(i)}\log(h_\theta(x^{(i)})) + (1-y^{(i)})\log(1-h_\theta(x^{(i)}))\right]$$

Siendo $h_\theta(x) = \sigma(\theta^T x)$ la función sigmoide.
```

> 💡 **Para ChatGPT**: cuando le pidas preguntas con fórmulas, incluye en tu prompt:
> *"Usa LaTeX con delimitadores `$...$` para inline y `$$...$$` para bloques. Las matrices con `\begin{bmatrix}...\end{bmatrix}`."*

---

## 🖼️ Imágenes en preguntas

Las preguntas pueden incluir **imágenes inline** directamente en el Markdown de cualquier campo de texto.

### Referencia de imagen en Markdown

```markdown
En la figura se muestra el resultado de aplicar el filtro con distintos valores de $\alpha$:

![Figura 1](question-images/550e8400-e29b-41d4-a716-446655440000.png)

Relaciona cada imagen con su valor de $\alpha$.
```

### Campo `questionImages` en el pack

Cuando un pack contiene preguntas con imágenes, el campo `questionImages` del pack exporta todas las imágenes en base64:

```json
{
  "version": 1,
  "kind": "contribution",
  "packId": "...",
  "questions": [
    {
      "prompt": "Analiza el siguiente diagrama:\n\n![Diagrama](question-images/uuid.png)",
      ...
    }
  ],
  "questionImages": {
    "uuid.png": "iVBORw0KGgoAAAANSUhEUgAA..."
  }
}
```

Al importar el pack, las imágenes se restauran automáticamente en el IndexedDB del receptor. No es necesario hacer nada especial.

> ⚠️ **Nota para ChatGPT**: ChatGPT no puede generar imágenes en base64 para el campo `questionImages`. Las imágenes deben añadirse manualmente desde la interfaz de la app (arrastrando o pegando). Si una pregunta de examen tiene imágenes, créala primero sin imagen y añade la imagen después desde el editor de preguntas.

---

## Ejemplos completos por tipo de pregunta

> ⚠️ **Todos los slugs de estos ejemplos son REALES y están sacados del Anexo.**  
> Cuando generes tus propias preguntas, copia los slugs del Anexo según el tema que corresponda.

### Pregunta TEST

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "subjectKey": "vision-artificial",
  "topicKey": "tema-7-procesamiento-de-imagen-operaciones-espaciales",
  "type": "TEST",
  "prompt": "¿Qué filtro se utiliza principalmente para detectar bordes en una imagen?",
  "origin": "clase",
  "difficulty": 2,
  "options": [
    { "id": "a", "text": "Filtro Gaussiano" },
    { "id": "b", "text": "Filtro de Sobel" },
    { "id": "c", "text": "Filtro de Media" },
    { "id": "d", "text": "Filtro Bilateral" }
  ],
  "correctOptionIds": ["b"],
  "explanation": "El filtro de Sobel es un operador diferencial que detecta bordes calculando el gradiente de la intensidad.",
  "tags": ["filtros", "bordes", "operadores"],
  "createdBy": "Carlos"
}
```

### Pregunta TEST con LaTeX

```json
{
  "id": "623e4567-e89b-12d3-a456-426614174005",
  "subjectKey": "vision-artificial",
  "topicKey": "tema-7-procesamiento-de-imagen-operaciones-espaciales",
  "type": "TEST",
  "prompt": "Dado el siguiente kernel $h$:\n\n$$h = \\begin{bmatrix} -1 & -1 & -1 \\\\ -1 & 8 & -1 \\\\ -1 & -1 & -1 \\end{bmatrix}$$\n\n¿Qué tipo de filtro es?",
  "origin": "examen_anterior",
  "difficulty": 3,
  "options": [
    { "id": "a", "text": "Filtro paso bajo (suavizado)" },
    { "id": "b", "text": "Filtro paso alto (realce de bordes)" },
    { "id": "c", "text": "Filtro de mediana" },
    { "id": "d", "text": "Filtro Gaussiano" }
  ],
  "correctOptionIds": ["b"],
  "explanation": "La suma de coeficientes es $-8 + 8 = 0$, lo que indica un filtro paso alto. El coeficiente central positivo y los negativos alrededor amplifican las diferencias locales (bordes).",
  "tags": ["filtros", "kernel", "paso-alto"],
  "createdBy": "Carlos"
}
```

### Pregunta DESARROLLO

```json
{
  "id": "223e4567-e89b-12d3-a456-426614174001",
  "subjectKey": "razonamiento-y-planificacion-automatica",
  "topicKey": "tema-5-busqueda-informada",
  "type": "DESARROLLO",
  "prompt": "Explica el funcionamiento del algoritmo A* y sus ventajas frente a la búsqueda no informada.",
  "origin": "alumno",
  "difficulty": 4,
  "modelAnswer": "A* combina búsqueda de costo uniforme con búsqueda heurística. Usa $f(n) = g(n) + h(n)$, donde $g(n)$ es el costo desde el origen y $h(n)$ es una heurística admisible. Garantiza optimalidad si $h$ es admisible...",
  "keywords": ["heurística", "admisible", "costo", "óptimo", "f(n)"],
  "tags": ["busqueda", "algoritmos", "heuristica"],
  "createdBy": "María"
}
```

### Pregunta COMPLETAR

```json
{
  "id": "323e4567-e89b-12d3-a456-426614174002",
  "subjectKey": "procesamiento-del-lenguaje-natural",
  "topicKey": "tema-2-el-texto-como-dato",
  "type": "COMPLETAR",
  "prompt": "Complete la siguiente frase sobre preprocesamiento de texto:",
  "origin": "test",
  "difficulty": 1,
  "clozeText": "El proceso de dividir texto en unidades mínimas se llama {{tokenización}} y es el primer paso del {{preprocesamiento}}.",
  "blanks": [
    {
      "id": "b1",
      "accepted": ["tokenización", "tokenizacion", "segmentación", "segmentacion"]
    },
    {
      "id": "b2",
      "accepted": ["preprocesamiento", "pre-procesamiento", "procesamiento previo"]
    }
  ],
  "tags": ["tokenizacion", "preprocesamiento", "basico"],
  "createdBy": "Luis"
}
```

### Pregunta PRACTICO

```json
{
  "id": "423e4567-e89b-12d3-a456-426614174003",
  "subjectKey": "tecnicas-de-aprendizaje-automatico",
  "topicKey": "tema-5-evaluacion-de-algoritmos-de-clasificacion",
  "type": "PRACTICO",
  "prompt": "Dado $VP=80$, $VN=70$, $FP=10$, $FN=20$, calcula la precisión (*Precision*) del clasificador.",
  "origin": "examen_anterior",
  "difficulty": 3,
  "modelAnswer": "$$\\text{Precisión} = \\frac{VP}{VP + FP} = \\frac{80}{80 + 10} = \\frac{80}{90} \\approx 0.889$$",
  "numericAnswer": "0.889",
  "keywords": ["precision", "VP", "FP", "matriz de confusion"],
  "tags": ["metricas", "clasificacion", "calculo"],
  "createdBy": "Pedro"
}
```

### Pregunta DESARROLLO Multi-Tema

```json
{
  "id": "523e4567-e89b-12d3-a456-426614174004",
  "subjectKey": "razonamiento-y-planificacion-automatica",
  "topicKey": "tema-5-busqueda-informada",
  "topicIds": [
    "tema-4-busqueda-no-informada",
    "tema-5-busqueda-informada"
  ],
  "type": "DESARROLLO",
  "prompt": "Compara las ventajas y desventajas de la búsqueda en anchura (BFS) frente al algoritmo A*. ¿En qué situaciones preferirías usar cada uno?",
  "origin": "clase",
  "difficulty": 4,
  "modelAnswer": "BFS garantiza la solución óptima en grafos no ponderados pero tiene alto consumo de memoria $O(b^d)$. A* es más eficiente si existe una buena heurística admisible, pero requiere conocimiento del dominio para definirla...",
  "keywords": ["BFS", "A*", "heurística", "optimalidad", "complejidad espacial"],
  "tags": ["busqueda", "comparacion", "algoritmos"],
  "createdBy": "Laura"
}
```

---

## 📦 Loose packs (asignaturas sin temas)

A veces creas una asignatura rápida para repasar, **sin temas**. Para esos casos existe el **loose pack**: un contribution pack que **no especifica asignatura ni tema por pregunta**.

### ¿Cuándo se pueden importar?

Un loose pack **solo puede importarse desde DENTRO de una asignatura** (botón **"↓ Pack"**, que aparece siempre en la vista de la asignatura). Al importarse desde ahí:

- Todas las preguntas se asignan **a esa asignatura** (por eso no hace falta `subjectKey`).
- Cada pregunta entra **sin tema** (`topicId` vacío), salvo que traiga un `topicKey` que coincida por título con un tema existente de esa asignatura.

> ⚠️ Si intentas importar un loose pack desde **Ajustes → Importar contribuciones**, fallará: al no traer asignatura, no hay a dónde asignar las preguntas. Impórtalo siempre desde dentro de la asignatura.

### Diferencias con un pack normal

| | Pack normal | Loose pack |
|---|---|---|
| `targets` | Lista de asignaturas y temas | `[]` (vacío) |
| `subjectKey` por pregunta | Obligatorio (del Anexo) | Se omite |
| `topicKey` por pregunta | Obligatorio (del Anexo) | Se omite (o opcional) |
| Dónde se importa | Ajustes **o** dentro de una asignatura | **Solo** dentro de la asignatura |
| Asignatura destino | La del `subjectKey` | La asignatura desde la que importas |

### Estructura de un loose pack

```json
{
  "version": 1,
  "kind": "contribution",
  "packId": "uuid-único-del-pack",
  "createdBy": "Nombre del Contribuidor",
  "exportedAt": "2026-07-11T12:00:00.000Z",
  "targets": [],
  "questions": [
    {
      "id": "uuid-de-la-pregunta",
      "type": "TEST",
      "prompt": "Texto de la pregunta",
      "origin": "alumno",
      "difficulty": 2,
      "options": [
        { "id": "a", "text": "Opción A" },
        { "id": "b", "text": "Opción B" }
      ],
      "correctOptionIds": ["a"],
      "explanation": "Explicación opcional",
      "tags": ["etiqueta1"]
    }
  ]
}
```

Los campos por tipo de pregunta (TEST / DESARROLLO / COMPLETAR / PRACTICO) y el formato Markdown+LaTeX son **idénticos** a los de un pack normal; lo único que cambia es que **`targets` va vacío** y las preguntas **no llevan `subjectKey` ni `topicKey`**.

> 💡 Hay un esqueleto listo para copiar en `GUIA_LOOSE_PACK_esqueleto.json`.

### Prompt para ChatGPT (loose pack)

```
Crea un contribution pack tipo "loose" (asignatura sin temas).
NO incluyas "subjectKey" ni "topicKey" en las preguntas, y pon "targets": [].
El pack se importará desde dentro de una asignatura, así que las preguntas
se asignarán automáticamente a esa asignatura.

Sigue el resto del formato de GUIA_CONTRIBUTION_PACKS.md:
- kind: "contribution", version: 1
- cada pregunta con "id" único, "type", "prompt", "origin", "difficulty"
- campos por tipo (options/correctOptionIds, modelAnswer, clozeText/blanks, etc.)
- Markdown y LaTeX ($...$ inline, $$...$$ bloque)

TAREA: crea 20 preguntas tipo TEST sobre [TEMA A REPASAR].
```

---

## Proceso recomendado para crear contribution packs con ChatGPT

1. **Exporta el banco actual** en formato compacto (Ajustes > Exportar banco compacto) para evitar duplicados
2. **Identifica el tema exacto** en el Anexo de Temarios al final de esta guía y copia el slug
3. **Usa este prompt con ChatGPT**:

```
Voy a crear un contribution pack de preguntas para mi banco de estudio.
Lee esta guía completa: GUIA_CONTRIBUTION_PACKS.md

══════════════════════════════════════════
🚨 SLUGS OBLIGATORIOS — NO INVENTAR
══════════════════════════════════════════
Los valores de "subjectKey" y "topicKey" son FIJOS e INMUTABLES.
NO los generes, NO los parafrasees, NO los simplifiques.
Cópialos LITERALMENTE de la sección "Anexo: Índices de Temario" de la guía.

subjectKey válidos (ÚNICAMENTE estos 5):
  - procesamiento-del-lenguaje-natural
  - vision-artificial
  - investigacion-y-gestion-de-proyectos-en-inteligencia-artificial
  - razonamiento-y-planificacion-automatica
  - tecnicas-de-aprendizaje-automatico

topicKey del tema a trabajar (copiado del Anexo):
  → [PEGA AQUÍ EL topicKey EXACTO DEL TEMA]

══════════════════════════════════════════

TAREA:
Crea 20 preguntas tipo TEST para:
  - Asignatura: "Técnicas de Aprendizaje Automático"
    subjectKey: "tecnicas-de-aprendizaje-automatico"
  - Tema: "Tema 8- Aprendizaje supervisado. Clasificación con Naïve Bayes"
    topicKey: "tema-8-aprendizaje-supervisado-clasificacion-con-naive-bayes"

REQUISITOS de cada pregunta:
1. Campo "origin" obligatorio: "test" | "examen_anterior" | "clase" | "alumno"
   (si creas preguntas desde cero usa "alumno")
2. difficulty entre 1 y 5
3. explanation siempre que sea posible
4. Texto en Markdown. Usa LaTeX con delimitadores $...$ (inline) y $$...$$ (bloque)
   para fórmulas matemáticas. Matrices con \begin{bmatrix}...\end{bmatrix}.
5. NO incluyas el campo "questionImages" — las imágenes se añaden manualmente

Banco actual (para evitar duplicados):
[PEGA AQUÍ EL JSON DEL BANCO COMPACTO EXPORTADO]

VERIFICACIÓN FINAL antes de responder:
✓ subjectKey == "tecnicas-de-aprendizaje-automatico" (exacto)
✓ topicKey == "tema-8-aprendizaje-supervisado-clasificacion-con-naive-bayes" (exacto)
✓ Todas las preguntas tienen "origin"
✓ No hay duplicados con el banco actual
✓ JSON válido (sin comentarios //)
✓ difficulty en todas las preguntas
✓ explanation incluida cuando sea posible
✓ Fórmulas con LaTeX donde corresponda
```

4. **Revisa el JSON generado**: verifica que `subjectKey` y `topicKey` coincidan exactamente con el Anexo
5. **Importa el pack** en Ajustes > Importar contribuciones para validar que no hay errores

---

## Validación y errores comunes

### ❌ Error: Slug inventado
```json
{
  "subjectKey": "ia-razonamiento-planificacion",  // ❌ No existe
  "topicKey": "tema-2-busqueda"                   // ❌ Slug incompleto
}
```
### ✅ Correcto:
```json
{
  "subjectKey": "razonamiento-y-planificacion-automatica",       // ✅ Del Anexo
  "topicKey": "tema-4-busqueda-no-informada"                     // ✅ Del Anexo
}
```

### ❌ Error: Falta el campo origin
```json
{
  "type": "TEST",
  "prompt": "¿Qué es un perceptrón?"
  // ❌ Falta "origin"
}
```
### ✅ Correcto:
```json
{
  "type": "TEST",
  "prompt": "¿Qué es un perceptrón?",
  "origin": "clase"  // ✅
}
```

### ❌ Error: LaTeX con delimitadores mal escapados en JSON
```json
{
  "prompt": "La función es \(f(x) = x^2\)"   // ❌ Las \ hay que escaparlas en JSON
}
```
### ✅ Correcto:
```json
{
  "prompt": "La función es $f(x) = x^2$"     // ✅ Más simple, sin problemas de escape
}
```
```json
{
  "prompt": "La función es \\(f(x) = x^2\\)" // ✅ Escapado correcto si usas \(...\)
}
```

### Otros errores comunes:
1. **Slugs incorrectos**: `subjectKey` y `topicKey` deben coincidir exactamente con el Anexo
2. **UUIDs duplicados**: cada pregunta debe tener un UUID único
3. **Tipo de pregunta incorrecto**: solo `"TEST"`, `"DESARROLLO"`, `"COMPLETAR"` o `"PRACTICO"`
4. **Opciones sin ID**: en TEST, cada opción necesita un `id` único
5. **`correctOptionIds` vacío**: en TEST debe haber al menos una opción correcta
6. **Comentarios `//` en JSON**: JSON no admite comentarios, elimínalos antes de importar

---

## Flujo completo de contribución

1. **Contribuidor crea preguntas**
   - Define su alias en Ajustes
   - Crea preguntas en la app o con ChatGPT usando esta guía
   - Si la pregunta tiene imágenes, las añade manualmente arrastrando/pegando en el editor
   - Exporta contribution pack desde Ajustes > Exportar mis preguntas

2. **Mantenedor importa el pack**
   - Recibe el JSON del contribuidor
   - Importa en Ajustes > Importar contribuciones
   - La app automáticamente:
     - Deduplica por hash de contenido
     - Crea asignaturas/temas si no existen
     - Mantiene trazabilidad (`createdBy`, `sourcePackId`)
     - Restaura las imágenes del campo `questionImages` en IndexedDB

3. **Mantenedor exporta banco global actualizado**
   - Exporta el banco completo
   - Comparte con todos los compañeros

---

## Herramientas útiles

- **UUID Generator**: https://www.uuidgenerator.net/
- **JSON Validator**: https://jsonlint.com/

---

## Anexo: Índices de Temario de las 5 Asignaturas

> 🚨 **Esta es la fuente de verdad para `subjectKey` y `topicKey`.**  
> Copia los slugs literalmente. No los modifiques ni abrevies.

---

### 1. Procesamiento del Lenguaje Natural

**`subjectKey`**: `procesamiento-del-lenguaje-natural`  
**`subjectName`**: `"Procesamiento del Lenguaje Natural"`

| # | Título del Tema | `topicKey` |
|---|-----------------|------------|
| 1 | Tema 1- Introducción al procesamiento del lenguaje natural | `tema-1-introduccion-al-procesamiento-del-lenguaje-natural` |
| 2 | Tema 2- El texto como dato | `tema-2-el-texto-como-dato` |
| 3 | Tema 3- Etiquetado morfosintáctico (POS tagging) | `tema-3-etiquetado-morfosintactico-pos-tagging` |
| 4 | Tema 4- Análisis sintáctico | `tema-4-analisis-sintactico` |
| 5 | Tema 5- Análisis semántico | `tema-5-analisis-semantico` |
| 6 | Tema 6- Semántica léxica | `tema-6-semantica-lexica` |
| 7 | Tema 7- Modelado estadístico del lenguaje | `tema-7-modelado-estadistico-del-lenguaje` |
| 8 | Tema 8- Modelado neuronal del lenguaje | `tema-8-modelado-neuronal-del-lenguaje` |
| 9 | Tema 9- Aplicaciones del procesamiento del lenguaje natural | `tema-9-aplicaciones-del-procesamiento-del-lenguaje-natural` |
| 10 | Tema 10- Agentes conversacionales | `tema-10-agentes-conversacionales` |

---

### 2. Visión Artificial

**`subjectKey`**: `vision-artificial`  
**`subjectName`**: `"Visión Artificial"`

| # | Título del Tema | `topicKey` |
|---|-----------------|------------|
| 1 | Tema 1- Introducción a los sistemas de percepción | `tema-1-introduccion-a-los-sistemas-de-percepcion` |
| 2 | Tema 2- Elementos de un sistema de percepción | `tema-2-elementos-de-un-sistema-de-percepcion` |
| 3 | Tema 3- Captura y digitalización de señales | `tema-3-captura-y-digitalizacion-de-senales` |
| 4 | Tema 4- Fuentes y tipos de ruido | `tema-4-fuentes-y-tipos-de-ruido` |
| 5 | Tema 5- Detección y cancelación de anomalías | `tema-5-deteccion-y-cancelacion-de-anomalias` |
| 6 | Tema 6- Procesamiento de imagen. Operaciones elementales | `tema-6-procesamiento-de-imagen-operaciones-elementales` |
| 7 | Tema 7- Procesamiento de imagen. Operaciones espaciales | `tema-7-procesamiento-de-imagen-operaciones-espaciales` |
| 8 | Tema 8- Procesamiento de imagen. Transformadas | `tema-8-procesamiento-de-imagen-transformadas` |
| 9 | Tema 9- Segmentación | `tema-9-segmentacion` |
| 10 | Tema 10- Extracción de características | `tema-10-extraccion-de-caracteristicas` |
| 11 | Tema 11- Clasificación | `tema-11-clasificacion` |
| 12 | Tema 12- Extracción de características. Deep Learning | `tema-12-extraccion-de-caracteristicas-deep-learning` |
| 13 | Tema 13- Detección de objetos | `tema-13-deteccion-de-objetos` |

---

### 3. Investigación y Gestión de Proyectos en IA

**`subjectKey`**: `investigacion-y-gestion-de-proyectos-en-inteligencia-artificial`  
**`subjectName`**: `"Investigación y Gestión de Proyectos en Inteligencia Artificial"`

| # | Título del Tema | `topicKey` |
|---|-----------------|------------|
| 1 | Tema 1- Origen y evolución de la inteligencia artificial | `tema-1-origen-y-evolucion-de-la-inteligencia-artificial` |
| 2 | Tema 2- Ciencia y método científico | `tema-2-ciencia-y-metodo-cientifico` |
| 3 | Tema 3- Financiación de proyectos | `tema-3-financiacion-de-proyectos` |
| 4 | Tema 4- Publicación de resultados y redacción científica | `tema-4-publicacion-de-resultados-y-redaccion-cientifica` |
| 5 | Tema 5- Gestión de proyectos de inteligencia artificial. Enfoque metodológico | `tema-5-gestion-de-proyectos-de-inteligencia-artificial-enfoque-metodologico` |
| 6 | Tema 6- Gestión de proyectos IA estructura de un proyecto IA y su despliegue | `tema-6-gestion-de-proyectos-ia-estructura-de-un-proyecto-ia-y-su-despliegue` |
| 7 | Tema 7-Gestión de proyectos IA. Recursos materiales y recursos humanos | `tema-7-gestion-de-proyectos-ia-recursos-materiales-y-recursos-humanos` |
| 8 | Tema 8- Investigación en agentes inteligentes y sistemas expertos | `tema-8-investigacion-en-agentes-inteligentes-y-sistemas-expertos` |
| 9 | Tema 9- Investigación en aprendizaje automático | `tema-9-investigacion-en-aprendizaje-automatico` |
| 10 | Tema 10- Investigación en sistemas cognitivos | `tema-10-investigacion-en-sistemas-cognitivos` |
| 11 | Tema 11- Investigación en computación bioinspirada | `tema-11-investigacion-en-computacion-bioinspirada` |
| 12 | Tema 12- Implicaciones filosóficas éticas y legales en la aplicación de la inteligencia artificial | `tema-12-implicaciones-filosoficas-eticas-y-legales-en-la-aplicacion-de-la-inteligencia-artificial` |

---

### 4. Razonamiento y Planificación Automática

**`subjectKey`**: `razonamiento-y-planificacion-automatica`  
**`subjectName`**: `"Razonamiento y Planificación Automática"`

| # | Título del Tema | `topicKey` |
|---|-----------------|------------|
| 1 | Tema 1- Introducción a la toma de decisiones | `tema-1-introduccion-a-la-toma-de-decisiones` |
| 2 | Tema 2- Representación del conocimiento y razonamiento | `tema-2-representacion-del-conocimiento-y-razonamiento` |
| 3 | Tema 3- Lógica y pensamiento humano | `tema-3-logica-y-pensamiento-humano` |
| 4 | Tema 4- Búsqueda no informada | `tema-4-busqueda-no-informada` |
| 5 | Tema 5- Búsqueda informada | `tema-5-busqueda-informada` |
| 6 | Tema 6- Búsqueda entre adversarios | `tema-6-busqueda-entre-adversarios` |
| 7 | Tema 7- Problemas de planificación | `tema-7-problemas-de-planificacion` |
| 8 | Tema 8- Sistemas basados en STRIP | `tema-8-sistemas-basados-en-strip` |
| 9 | Tema 9- Redes de tareas jerárquicas (HTN) | `tema-9-redes-de-tareas-jerarquicas-htn` |
| 10 | Tema 10- Planificación multi agente | `tema-10-planificacion-multi-agente` |
| 11 | Tema 11- Planificación por múltiples agentes | `tema-11-planificacion-por-multiples-agentes` |
| 12 | Tema 12- Reparación reactiva multi agente | `tema-12-reparacion-reactiva-multi-agente` |
---

### 5. Técnicas de Aprendizaje Automático

**`subjectKey`**: `tecnicas-de-aprendizaje-automatico`  
**`subjectName`**: `"Técnicas de Aprendizaje Automático"`

| # | Título del Tema | `topicKey` |
|---|-----------------|------------|
| 1 | Tema 1- Introducción al aprendizaje automático | `tema-1-introduccion-al-aprendizaje-automatico` |
| 2 | Tema 2- Análisis de datos descriptivo y exploratorio | `tema-2-analisis-de-datos-descriptivo-y-exploratorio` |
| 3 | Tema 3- Datos ausentes y normalización | `tema-3-datos-ausentes-y-normalizacion` |
| 4 | Tema 4- Regresión y evaluación de algoritmos de regresión | `tema-4-regresion-y-evaluacion-de-algoritmos-de-regresion` |
| 5 | Tema 5- Evaluación de algoritmos de clasificación | `tema-5-evaluacion-de-algoritmos-de-clasificacion` |
| 6 | Tema 6- Aprendizaje supervisado. Regresión y clasificación con árboles de decisión | `tema-6-aprendizaje-supervisado-regresion-y-clasificacion-con-arboles-de-decision` |
| 7 | Tema 7- Máquinas de vectores de soporte | `tema-7-maquinas-de-vectores-de-soporte` |
| 8 | Tema 8- Aprendizaje supervisado. Clasificación con Naïve Bayes | `tema-8-aprendizaje-supervisado-clasificacion-con-naive-bayes` |
| 9 | Tema 9- Combinacion de clasificadores. Bootstrapping Bagging y Boosting | `tema-9-combinacion-de-clasificadores-bootstrapping-bagging-y-boosting` |
| 10 | Tema 10- Aprendizaje supervisado. Regresión y clasificación con Random Forest | `tema-10-aprendizaje-supervisado-regresion-y-clasificacion-con-random-forest` |
| 11 | Tema 11- Parametrización automática y optimización de algoritmos | `tema-11-parametrizacion-automatica-y-optimizacion-de-algoritmos` |


**`subjectKey`**: `desarrollo-optimizacion-y-despliegue-de-modelos-generativos`  
**`subjectName`**: `"Desarrollo, Optimización y Despliegue de Modelos Generativos"`

| # | Título del Tema | `topicKey` |
|---|-----------------|------------|
| 1 | Tema 1. Fundamentos y evaluación de modelos de lenguaje | `tema-1-fundamentos-y-evaluacion-de-modelos-de-lenguaje` |
| 2 | Tema 2. RAG en Flowise | `tema-2-rag-en-flowise` |
| 3 | Tema 3. Del chat al agente. Herramientas, memoria y enrutado | `tema-3-del-chat-al-agente-herramientas-memoria-y-enrutado` |
| 4 | Tema 4. Calidad operativa. Moderación, HITL y trazabilidad | `tema-4-calidad-operativa-moderacion-hitl-y-trazabilidad` |
| 5 | Tema 5. Automatización por eventos e integración con servicios | `tema-5-automatizacion-por-eventos-e-integracion-con-servicios` |
| 6 | Tema 6. Interoperabilidad no-code con MCP | `tema-6-interoperabilidad-no-code-con-mcp` |
| 7 | Tema 7. Sistemas multiagente | `tema-7-sistemas-multiagente` |
| 8 | Tema 8. Agentes multimodales y publicación como servicio | `tema-8-agentes-multimodales-y-publicacion-como-servicio` |

## Soporte

Si tienes dudas o encuentras errores:
1. Verifica el slug en el Anexo de esta guía
2. Valida el JSON en https://jsonlint.com/
3. Importa el pack en la app para ver mensajes de error detallados
4. Consulta el código en `src/data/contributionImport.ts`
