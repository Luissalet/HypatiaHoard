# Guía para crear packs de Conceptos Clave

## ¿Qué es un pack de Conceptos Clave?

Un **pack de conceptos clave** es un archivo JSON que contiene fórmulas, definiciones y observaciones importantes de una asignatura. Este formato permite:

- Que **ChatGPT** (u otro chatbot) genere conceptos clave automáticamente a partir de apuntes, temarios o exámenes
- **Compartir** los conceptos con compañeros vía GitHub o archivo JSON
- **Importar** directamente en la app ExamCoach desde el tab "Conceptos clave" de cualquier asignatura

---

## 🚨 REGLA CRÍTICA — SLUGS EXACTOS OBLIGATORIOS

> **Para ChatGPT y cualquier herramienta que genere packs de conceptos:**
>
> Los valores de `subjectKey` y `topicKey` **NO se inventan, NO se generan, NO se parafrasean**.
> Deben copiarse **literalmente** del **Anexo de Temarios** al final de esta guía.
>
> **Lista completa de `subjectKey` válidos — solo estos, sin variaciones:**
>
> | Asignatura | `subjectKey` exacto |
> |---|---|
> | Procesamiento del Lenguaje Natural | `procesamiento-del-lenguaje-natural` |
> | Visión Artificial | `vision-artificial` |
> | Investigación y Gestión de Proyectos en IA | `investigacion-y-gestion-de-proyectos-en-inteligencia-artificial` |
> | Razonamiento y Planificación Automática | `razonamiento-y-planificacion-automatica` |
> | Técnicas de Aprendizaje Automático | `tecnicas-de-aprendizaje-automatico` |
> | Desarrollo, Optimización y Despliegue de Modelos Generativos | `desarrollo-optimizacion-y-despliegue-de-modelos-generativos` |
>
> ❌ **INCORRECTO**: `"ia-razonamiento"`, `"vision"`, `"tecnicas-aprendizaje"`
> ✅ **CORRECTO**: Copia textualmente de la tabla de arriba o del Anexo al final de esta guía.
>
> Lo mismo aplica para `topicKey`: cada tema tiene un slug único definido en el Anexo. Si el slug no aparece exactamente en el Anexo, está mal.

---

## Estructura completa del Pack de Conceptos

```json
{
  "version": 1,
  "kind": "keyconcepts",
  "packId": "uuid-único-del-pack",
  "createdBy": "Nombre del Contribuidor",
  "exportedAt": "2026-02-23T12:00:00.000Z",
  "subjectKey": "slug-de-la-asignatura",
  "subjectName": "Nombre Completo de la Asignatura",
  "topics": [
    {
      "topicKey": "slug-del-tema",
      "topicTitle": "Título Completo del Tema"
    }
  ],
  "concepts": [
    {
      "id": "uuid-del-concepto",
      "topicKey": "slug-del-tema",
      "category": "formula",
      "title": "Nombre de la fórmula",
      "content": "$$E = mc^2$$\n\nDonde $m$ es la masa y $c$ la velocidad de la luz.",
      "tags": ["relatividad", "energía"],
      "order": 0
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
| `kind` | string | ✅ | Siempre `"keyconcepts"` |
| `packId` | string | ✅ | UUID único del pack |
| `createdBy` | string | ✅ | Nombre/alias del contribuidor |
| `exportedAt` | string | ✅ | Fecha ISO de exportación |
| `subjectKey` | string | ✅ | Slug de la asignatura — **del Anexo** |
| `subjectName` | string | ✅ | Nombre completo de la asignatura |
| `topics` | array | ⭕ | Temas referenciados (para crear los que no existan) |
| `concepts` | array | ✅ | Conceptos del pack |

### Campos de cada concepto

| Campo | Tipo | Obligatorio | Descripción | Valores posibles |
|-------|------|-------------|-------------|------------------|
| `id` | string | ✅ | UUID único | UUID v4 |
| `topicKey` | string | ⭕ | Slug del tema — **del Anexo** | ver Anexo |
| `category` | string | ✅ | Categoría del concepto | `"formula"`, `"definition"`, `"remark"` |
| `title` | string | ✅ | Título/nombre del concepto | Texto breve |
| `content` | string | ✅ | Contenido completo | Markdown + LaTeX |
| `tags` | array | ⭕ | Etiquetas | `["tag1", "tag2"]` |
| `order` | number | ✅ | Orden dentro de su categoría | `0`, `1`, `2`... |
| `createdBy` | string | ⭕ | Autor del concepto | Nombre/alias |
| `contentHash` | string | ⭕ | Hash para deduplicación (auto-generado si falta) | `"sha256:..."` |

---

## Las 3 categorías

| Categoría | `category` | Para qué se usa | Ejemplo |
|-----------|-----------|-----------------|---------|
| **Fórmula** | `"formula"` | Ecuaciones, identidades, relaciones matemáticas | Teorema de Bayes, distancia euclídea, función sigmoide |
| **Definición** | `"definition"` | Conceptos, términos técnicos, descripciones formales | Overfitting, heurística admisible, tokenización |
| **Observación** | `"remark"` | Tips, notas importantes, aclaraciones, errores frecuentes | "No confundir precisión con exactitud", "Caso especial cuando n=0" |

---

## ✍️ Markdown y LaTeX en el contenido

El campo `content` soporta **Markdown completo** y **fórmulas LaTeX** renderizadas con KaTeX.

### Delimitadores de fórmulas

| Tipo | Inline | Bloque (display) |
|------|--------|-----------------|
| Estilo pandoc/KaTeX | `$...$` | `$$...$$` |
| Estilo LaTeX estándar | `\(...\)` | `\[...\]` |

### Ejemplo de contenido con LaTeX

```markdown
$$P(A|B) = \frac{P(B|A) \cdot P(A)}{P(B)}$$

Donde:
- $P(A|B)$: probabilidad posterior de $A$ dado $B$
- $P(B|A)$: verosimilitud (*likelihood*)
- $P(A)$: probabilidad a priori
- $P(B)$: evidencia (constante de normalización)
```

> 💡 **Para ChatGPT**: usa delimitadores `$...$` para inline y `$$...$$` para bloques. Matrices con `\begin{bmatrix}...\end{bmatrix}`. Es lo más seguro dentro de JSON.

---

## Ejemplos completos por categoría

> ⚠️ **Todos los slugs de estos ejemplos son REALES y están sacados del Anexo.**

### Fórmula

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "topicKey": "tema-8-aprendizaje-supervisado-clasificacion-con-naive-bayes",
  "category": "formula",
  "title": "Teorema de Bayes",
  "content": "$$P(C_k | \\mathbf{x}) = \\frac{P(\\mathbf{x} | C_k) \\cdot P(C_k)}{P(\\mathbf{x})}$$\n\nDonde:\n- $P(C_k | \\mathbf{x})$: probabilidad posterior de la clase $C_k$ dado el vector de características $\\mathbf{x}$\n- $P(\\mathbf{x} | C_k)$: verosimilitud\n- $P(C_k)$: probabilidad a priori de la clase\n- $P(\\mathbf{x})$: evidencia (constante de normalización)",
  "tags": ["bayes", "probabilidad", "clasificación"],
  "order": 0
}
```

### Fórmula con matrices

```json
{
  "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "topicKey": "tema-7-procesamiento-de-imagen-operaciones-espaciales",
  "category": "formula",
  "title": "Kernel de Sobel (detección de bordes)",
  "content": "Kernel horizontal $G_x$ y vertical $G_y$:\n\n$$G_x = \\begin{bmatrix} -1 & 0 & 1 \\\\ -2 & 0 & 2 \\\\ -1 & 0 & 1 \\end{bmatrix}, \\qquad G_y = \\begin{bmatrix} -1 & -2 & -1 \\\\ 0 & 0 & 0 \\\\ 1 & 2 & 1 \\end{bmatrix}$$\n\nMagnitud del gradiente: $G = \\sqrt{G_x^2 + G_y^2}$",
  "tags": ["sobel", "bordes", "filtros", "kernel"],
  "order": 1
}
```

### Definición

```json
{
  "id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
  "topicKey": "tema-5-busqueda-informada",
  "category": "definition",
  "title": "Heurística admisible",
  "content": "Una función heurística $h(n)$ es **admisible** si nunca sobreestima el coste real de alcanzar el objetivo desde el nodo $n$:\n\n$$h(n) \\leq h^*(n) \\quad \\forall n$$\n\nDonde $h^*(n)$ es el coste real óptimo desde $n$ hasta el objetivo.\n\nSi la heurística es admisible, el algoritmo **A*** garantiza encontrar la solución óptima.",
  "tags": ["heurística", "A*", "búsqueda", "optimalidad"],
  "order": 0
}
```

### Definición (sin fórmulas)

```json
{
  "id": "d4e5f6a7-b8c9-0123-defa-234567890123",
  "topicKey": "tema-2-el-texto-como-dato",
  "category": "definition",
  "title": "Tokenización",
  "content": "Proceso de dividir un texto en unidades mínimas llamadas **tokens**. Estos pueden ser palabras, subpalabras, caracteres o n-gramas según el método empleado.\n\nMétodos comunes:\n- **Word-level**: separa por espacios y puntuación\n- **Subword** (BPE, WordPiece): divide palabras raras en subunidades frecuentes\n- **Character-level**: cada carácter es un token",
  "tags": ["tokenización", "preprocesamiento", "NLP"],
  "order": 1
}
```

### Observación

```json
{
  "id": "e5f6a7b8-c9d0-1234-efab-345678901234",
  "topicKey": "tema-5-evaluacion-de-algoritmos-de-clasificacion",
  "category": "remark",
  "title": "Precisión vs Exactitud (Precision vs Accuracy)",
  "content": "**No confundir** estos dos términos:\n\n- **Accuracy** (exactitud): proporción de predicciones correctas sobre el total → $\\frac{VP + VN}{VP + VN + FP + FN}$\n- **Precision** (precisión): de los predichos positivos, cuántos son realmente positivos → $\\frac{VP}{VP + FP}$\n\n⚠️ En datasets **desbalanceados**, accuracy puede ser engañosa. Un modelo que siempre predice la clase mayoritaria tendrá alta accuracy pero precisión/recall nulos para la clase minoritaria.",
  "tags": ["métricas", "precision", "accuracy", "desbalanceo"],
  "order": 0
}
```

### Observación (tip práctico)

```json
{
  "id": "f6a7b8c9-d0e1-2345-fabc-456789012345",
  "topicKey": "tema-3-datos-ausentes-y-normalizacion",
  "category": "remark",
  "title": "Normalizar DESPUÉS de dividir train/test",
  "content": "⚠️ **Error frecuente en exámenes**: normalizar (min-max, z-score) con estadísticos calculados sobre TODO el dataset antes de hacer la partición train/test.\n\nEsto provoca **data leakage**: información del test se filtra al entrenamiento.\n\n**Correcto**:\n1. Dividir train/test\n2. Calcular media y desviación SOLO con train\n3. Aplicar esos estadísticos a train Y test",
  "tags": ["normalización", "data-leakage", "train-test", "error-frecuente"],
  "order": 1
}
```

---

## Pack completo de ejemplo

```json
{
  "version": 1,
  "kind": "keyconcepts",
  "packId": "550e8400-e29b-41d4-a716-446655440000",
  "createdBy": "Luis",
  "exportedAt": "2026-02-23T12:00:00.000Z",
  "subjectKey": "tecnicas-de-aprendizaje-automatico",
  "subjectName": "Técnicas de Aprendizaje Automático",
  "topics": [
    {
      "topicKey": "tema-5-evaluacion-de-algoritmos-de-clasificacion",
      "topicTitle": "Tema 5- Evaluación de algoritmos de clasificación"
    },
    {
      "topicKey": "tema-8-aprendizaje-supervisado-clasificacion-con-naive-bayes",
      "topicTitle": "Tema 8- Aprendizaje supervisado. Clasificación con Naïve Bayes"
    }
  ],
  "concepts": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "topicKey": "tema-8-aprendizaje-supervisado-clasificacion-con-naive-bayes",
      "category": "formula",
      "title": "Clasificador Naïve Bayes",
      "content": "$$\\hat{y} = \\arg\\max_{C_k} P(C_k) \\prod_{i=1}^{n} P(x_i | C_k)$$\n\nAsume **independencia condicional** entre las características dado la clase.",
      "tags": ["naive-bayes", "clasificación"],
      "order": 0
    },
    {
      "id": "22222222-2222-2222-2222-222222222222",
      "topicKey": "tema-8-aprendizaje-supervisado-clasificacion-con-naive-bayes",
      "category": "formula",
      "title": "Suavizado de Laplace",
      "content": "Para evitar probabilidades cero cuando un valor de característica no aparece en el entrenamiento:\n\n$$P(x_i | C_k) = \\frac{\\text{count}(x_i, C_k) + \\alpha}{\\text{count}(C_k) + \\alpha \\cdot |V|}$$\n\nDonde $\\alpha = 1$ (Laplace) y $|V|$ es el número de valores posibles de $x_i$.",
      "tags": ["naive-bayes", "laplace", "suavizado"],
      "order": 1
    },
    {
      "id": "33333333-3333-3333-3333-333333333333",
      "topicKey": "tema-5-evaluacion-de-algoritmos-de-clasificacion",
      "category": "definition",
      "title": "Matriz de confusión",
      "content": "Tabla que resume las predicciones del clasificador frente a los valores reales:\n\n|  | Predicho + | Predicho − |\n|--|-----------|------------|\n| **Real +** | VP (Verdadero Positivo) | FN (Falso Negativo) |\n| **Real −** | FP (Falso Positivo) | VN (Verdadero Negativo) |\n\nA partir de ella se calculan: accuracy, precision, recall, F1-score, especificidad.",
      "tags": ["métricas", "clasificación", "evaluación"],
      "order": 0
    },
    {
      "id": "44444444-4444-4444-4444-444444444444",
      "topicKey": "tema-5-evaluacion-de-algoritmos-de-clasificacion",
      "category": "formula",
      "title": "F1-Score",
      "content": "Media armónica de precision y recall:\n\n$$F_1 = 2 \\cdot \\frac{\\text{Precision} \\cdot \\text{Recall}}{\\text{Precision} + \\text{Recall}}$$\n\nÚtil cuando hay **desbalanceo de clases** y queremos equilibrar ambas métricas.",
      "tags": ["F1", "métricas", "precision", "recall"],
      "order": 2
    },
    {
      "id": "55555555-5555-5555-5555-555555555555",
      "topicKey": "tema-8-aprendizaje-supervisado-clasificacion-con-naive-bayes",
      "category": "remark",
      "title": "La asunción de independencia casi nunca se cumple",
      "content": "Naïve Bayes asume que las características son **condicionalmente independientes** dada la clase. En la práctica esto casi nunca es cierto (ej: en texto, las palabras están correlacionadas).\n\nSin embargo, el clasificador funciona sorprendentemente bien incluso cuando la asunción se viola, porque lo que importa es el **ranking** de las probabilidades, no su valor absoluto.",
      "tags": ["naive-bayes", "independencia", "limitaciones"],
      "order": 0
    }
  ]
}
```

---

## Proceso recomendado para crear packs con ChatGPT

1. **Identifica la asignatura y el/los tema(s)** en el Anexo de Temarios
2. **Copia los slugs exactos** de `subjectKey` y `topicKey`
3. **Usa este prompt con ChatGPT**:

```
Voy a crear un pack de conceptos clave para mi app de estudio ExamCoach.
Lee esta guía completa: GUIA_CONCEPTOS_CLAVE.md

══════════════════════════════════════════
🚨 SLUGS OBLIGATORIOS — NO INVENTAR
══════════════════════════════════════════
Los valores de "subjectKey" y "topicKey" son FIJOS e INMUTABLES.
NO los generes, NO los parafrasees, NO los simplifiques.
Cópialos LITERALMENTE de la sección "Anexo: Índices de Temario" de la guía.

subjectKey de la asignatura:
  → [PEGA AQUÍ EL subjectKey EXACTO]

subjectName de la asignatura:
  → [PEGA AQUÍ EL NOMBRE COMPLETO]

topicKey de los temas a cubrir (copiados del Anexo):
  → [PEGA AQUÍ LOS topicKey EXACTOS]

══════════════════════════════════════════

TAREA:
Genera un pack de conceptos clave para:
  - Asignatura: "[NOMBRE]"
    subjectKey: "[SLUG]"
  - Tema(s): "[NOMBRE DEL TEMA]"
    topicKey: "[SLUG DEL TEMA]"

REQUISITOS:
1. Genera al menos:
   - 5-10 FÓRMULAS (category: "formula"): todas las ecuaciones importantes del tema
   - 5-10 DEFINICIONES (category: "definition"): términos técnicos clave
   - 3-5 OBSERVACIONES (category: "remark"): tips, errores frecuentes, aclaraciones
2. Cada concepto DEBE tener:
   - "id": UUID v4 único
   - "topicKey": del Anexo (exacto)
   - "category": "formula" | "definition" | "remark"
   - "title": nombre corto y descriptivo
   - "content": explicación completa en Markdown + LaTeX
   - "tags": al menos 2 etiquetas relevantes
   - "order": número secuencial dentro de su categoría (empezando en 0)
3. Para fórmulas:
   - Usa LaTeX con $...$ (inline) y $$...$$ (bloque)
   - Matrices con \begin{bmatrix}...\end{bmatrix}
   - Incluye SIEMPRE qué significa cada variable
4. Para definiciones:
   - Incluye la definición formal y, si aplica, ejemplos o casos de uso
5. Para observaciones:
   - Incluye tips prácticos, errores frecuentes de examen, o aclaraciones
6. JSON válido: sin comentarios //, strings bien escapados
7. El "order" de cada categoría empieza en 0 y es consecutivo

MATERIAL DE REFERENCIA:
[PEGA AQUÍ APUNTES, TEMARIO O CONTENIDO DEL TEMA]

VERIFICACIÓN FINAL antes de responder:
✓ version == 1
✓ kind == "keyconcepts"
✓ packId es un UUID válido
✓ subjectKey == "[SLUG EXACTO]"
✓ Todos los topicKey son del Anexo
✓ Cada concepto tiene id, category, title, content, order, tags
✓ Las fórmulas LaTeX están correctamente escapadas para JSON
✓ JSON válido (sin comentarios //)
✓ Al menos 5 fórmulas, 5 definiciones y 3 observaciones
```

4. **Revisa el JSON generado**: verifica slugs, fórmulas LaTeX, y estructura
5. **Importa el pack** en la app: tab "Conceptos clave" > "Importar JSON"

---

## Variantes del prompt

### Para un tema específico a partir de apuntes

```
[Misma cabecera con slugs...]

TAREA: Extrae TODOS los conceptos clave de estos apuntes:

[PEGA AQUÍ EL CONTENIDO DE LOS APUNTES]

Genera:
- Una FÓRMULA por cada ecuación que aparezca
- Una DEFINICIÓN por cada término técnico nuevo
- Una OBSERVACIÓN por cada nota, advertencia o truco mencionado
```

### Para preparar un examen (cobertura completa)

```
[Misma cabecera con slugs...]

TAREA: Genera un "cheat sheet" completo del tema, como si fuera una chuleta de examen.
Incluye TODAS las fórmulas que puedan preguntarse, TODAS las definiciones que
hay que saber de memoria, y observaciones sobre errores típicos de examen.
```

### Para complementar conceptos existentes

```
[Misma cabecera con slugs...]

Ya tengo estos conceptos (para evitar duplicados):
[PEGA AQUÍ LA EXPORTACIÓN JSON ACTUAL]

TAREA: Genera conceptos ADICIONALES que falten. No repitas los que ya existen.
```

---

## Validación y errores comunes

### ❌ Error: Slug inventado
```json
{
  "subjectKey": "aprendizaje-automatico",
  "topicKey": "tema-5-evaluacion"
}
```
### ✅ Correcto:
```json
{
  "subjectKey": "tecnicas-de-aprendizaje-automatico",
  "topicKey": "tema-5-evaluacion-de-algoritmos-de-clasificacion"
}
```

### ❌ Error: category mal escrito
```json
{
  "category": "definicion"
}
```
### ✅ Correcto:
```json
{
  "category": "definition"
}
```

### ❌ Error: kind incorrecto
```json
{
  "kind": "concepts"
}
```
### ✅ Correcto:
```json
{
  "kind": "keyconcepts"
}
```

### ❌ Error: LaTeX mal escapado en JSON
```json
{
  "content": "La fórmula es \frac{1}{2}"
}
```
### ✅ Correcto:
```json
{
  "content": "La fórmula es $\\frac{1}{2}$"
}
```

### Otros errores comunes:
1. **`kind` incorrecto**: debe ser `"keyconcepts"` (no `"concepts"`, `"key-concepts"`, etc.)
2. **`category` en español**: usar `"formula"`, `"definition"`, `"remark"` (en inglés)
3. **Falta `order`**: cada concepto necesita un número de orden secuencial por categoría
4. **UUIDs duplicados**: cada concepto y cada pack debe tener un UUID único
5. **Comentarios en JSON**: JSON no admite `//` ni `/* */`, elimínalos
6. **Backslash sin escapar**: en JSON, `\` se escribe `\\` (ej: `\\frac`, `\\begin`)

---

## Cómo importar en la app

1. Ve a la asignatura en ExamCoach
2. Haz clic en el tab **"Conceptos clave"**
3. Pulsa **"Importar JSON"**
4. Selecciona el archivo `.json` o **pega el contenido JSON** directamente
5. Pulsa **"Importar"**
6. La app automáticamente:
   - Valida la estructura del JSON
   - Deduplica por hash de contenido (no importa conceptos ya existentes)
   - Crea temas que no existan (si están en el campo `topics`)
   - Muestra un resumen: conceptos nuevos, duplicados, errores

## Cómo exportar desde la app

1. Ve a la asignatura > tab **"Conceptos clave"**
2. Pulsa **"Exportar JSON"**
3. Se descarga un archivo `conceptos-[asignatura].json` con el formato de esta guía
4. Compártelo por GitHub, envíalo a compañeros, o úsalo como backup

---

## Herramientas útiles

- **UUID Generator**: https://www.uuidgenerator.net/
- **JSON Validator**: https://jsonlint.com/
- **LaTeX Preview**: https://www.katex.org/ (usa el mismo motor que la app)

---

## Anexo: Índices de Temario de las Asignaturas

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

---

### 6. Desarrollo, Optimización y Despliegue de Modelos Generativos

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

---

## Soporte

Si tienes dudas o encuentras errores:
1. Verifica el slug en el Anexo de esta guía
2. Valida el JSON en https://jsonlint.com/
3. Importa el pack en la app para ver mensajes de error detallados
4. Consulta el código en `src/data/keyConceptsImport.ts`
