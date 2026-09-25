# Guía de Formato Markdown + KaTeX para Exam Coach

## Motor de Renderizado

Exam Coach renderiza texto usando **marked** (Markdown) + **marked-katex-extension** (KaTeX). Todos los campos de texto (`prompt`, `explanation`, `modelAnswer`, `options[].text`, `clozeText`) pasan por este pipeline.

El sistema soporta Markdown estándar y fórmulas matemáticas con KaTeX. Esta guía explica exactamente cómo escribir contenido que se renderice correctamente.

---

## 1. Delimitadores Matemáticos

### 1.1 Inline (dentro del texto)

Usa `$...$` para matemáticas dentro de una línea de texto.

```
La fórmula $E = mc^2$ es fundamental.
El valor de $x_i$ en la iteración $t$.
```

También se acepta `\(...\)` (se convierte internamente a `$...$`):
```
La probabilidad \(P(A|B)\) se calcula con Bayes.
```

**Recomendación:** Usa siempre `$...$`. Es más corto y menos propenso a errores de escape en JSON.

### 1.2 Display (bloque centrado)

Usa `$$...$$` para ecuaciones en bloque:

```
$$\sum_{i=1}^{n} x_i = S$$
```

También se acepta `\[...\]` (se convierte internamente a `$$...$$`):
```
\[\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}\]
```

**Recomendación:** Usa siempre `$$...$$`.

### 1.3 Regla importante: NO mezclar delimitadores

Mal:
```
$\frac{1}{2}$$    ← abre con $ y cierra con $$
```

Bien:
```
$\frac{1}{2}$     ← inline
$$\frac{1}{2}$$   ← display
```

---

## 2. Escaping en JSON — La Fuente Principal de Errores

**Este es el punto más crítico.** Cuando escribes LaTeX dentro de un string JSON, cada barra invertida `\` debe escaparse como `\\`.

### 2.1 Regla de oro

| Lo que quieres renderizar | En JSON escribes |
|---|---|
| `$\frac{1}{2}$` | `"$\\frac{1}{2}$"` |
| `$\sum_{i=1}^n$` | `"$\\sum_{i=1}^n$"` |
| `$\alpha + \beta$` | `"$\\alpha + \\beta$"` |
| `$\begin{bmatrix}...\end{bmatrix}$` | `"$\\begin{bmatrix}...\\end{bmatrix}$"` |
| `$a \\ b$` (nueva línea en math) | `"$a \\\\ b$"` |
| `$$a \\ b$$` (salto en display) | `"$$a \\\\ b$$"` |

### 2.2 Error común: doble escape

```json
// ❌ INCORRECTO — doble escape (\\\\frac en JSON = \\frac en string)
{"prompt": "$\\\\frac{1}{2}$"}

// ✅ CORRECTO — un solo escape (\\frac en JSON = \frac en string)
{"prompt": "$\\frac{1}{2}$"}
```

### 2.3 Error común: sin escape

```json
// ❌ INCORRECTO — \f es un carácter de control, JSON inválido
{"prompt": "$\frac{1}{2}$"}

// ✅ CORRECTO
{"prompt": "$\\frac{1}{2}$"}
```

### 2.4 Saltos de línea en display math

Para múltiples líneas en display math (dentro de environments como `aligned`, `cases`, `bmatrix`), el `\\` de LaTeX se convierte en `\\\\` en JSON:

```json
{
  "prompt": "$$\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}$$"
}
```

Esto en el string real produce:
```
$$\begin{aligned} a &= b \\ c &= d \end{aligned}$$
```

### 2.5 Tabla rápida de escaping JSON

| Carácter LaTeX | En JSON | Ejemplo |
|---|---|---|
| `\` (una barra) | `\\` | `\\frac`, `\\sum`, `\\alpha` |
| `\\` (doble barra = newline en math) | `\\\\` | `a \\\\ b` dentro de aligned/bmatrix |
| `"` (comillas) | `\\"` | `\\text{\\"hola\\"}` |
| Newline real | `\\n` | Solo si quieres un salto de línea en el Markdown |

---

## 3. Markdown Soportado

### 3.1 Formato de texto

```
**negrita**
*cursiva*
`código inline`
~~tachado~~
```

### 3.2 Listas

```
- Elemento 1
- Elemento 2
  - Sub-elemento

1. Primero
2. Segundo
```

**En JSON** los saltos de línea se escriben como `\n`:
```json
{"prompt": "Opciones:\n- A: $x = 1$\n- B: $x = 2$\n- C: $x = 3$"}
```

### 3.3 Tablas

```
| Columna 1 | Columna 2 |
|-----------|-----------|
| Valor A   | $x^2$    |
| Valor B   | $y^2$    |
```

En JSON:
```json
{"prompt": "| Col 1 | Col 2 |\\n|-------|-------|\\n| A | $x^2$ |\\n| B | $y^2$ |"}
```

### 3.4 Código

````
```python
def hello():
    print("world")
```
````

### 3.5 Encabezados (usar con moderación)

```
### Sección
#### Subsección
```

---

## 4. Comandos KaTeX Soportados

### 4.1 Operaciones básicas

| Renderiza | Escribes (dentro de `$...$`) | En JSON |
|---|---|---|
| fracciones | `\frac{a}{b}` | `\\frac{a}{b}` |
| raíces | `\sqrt{x}`, `\sqrt[3]{x}` | `\\sqrt{x}`, `\\sqrt[3]{x}` |
| subíndice | `x_i`, `x_{ij}` | `x_i`, `x_{ij}` |
| superíndice | `x^2`, `x^{n+1}` | `x^2`, `x^{n+1}` |
| paréntesis grandes | `\left( \frac{a}{b} \right)` | `\\left( \\frac{a}{b} \\right)` |

### 4.2 Letras griegas

| Renderiza | Escribes | En JSON |
|---|---|---|
| α, β, γ, δ | `\alpha, \beta, \gamma, \delta` | `\\alpha, \\beta, \\gamma, \\delta` |
| ε, θ, λ, μ | `\epsilon, \theta, \lambda, \mu` | `\\epsilon, \\theta, \\lambda, \\mu` |
| π, σ, τ, φ | `\pi, \sigma, \tau, \phi` | `\\pi, \\sigma, \\tau, \\phi` |
| Σ, Π, Ω | `\Sigma, \Pi, \Omega` | `\\Sigma, \\Pi, \\Omega` |

### 4.3 Operadores y relaciones

| Renderiza | Escribes | En JSON |
|---|---|---|
| ≤, ≥, ≠ | `\leq, \geq, \neq` | `\\leq, \\geq, \\neq` |
| ≈, ∝, ∈ | `\approx, \propto, \in` | `\\approx, \\propto, \\in` |
| ×, ÷, ± | `\times, \div, \pm` | `\\times, \\div, \\pm` |
| →, ⇒, ↔ | `\to, \Rightarrow, \Leftrightarrow` | `\\to, \\Rightarrow, \\Leftrightarrow` |
| ∧, ∨, ¬ | `\land, \lor, \neg` | `\\land, \\lor, \\neg` |

### 4.4 Sumatorias, integrales, límites

```
$\sum_{i=1}^{n} x_i$                    → JSON: "$\\sum_{i=1}^{n} x_i$"
$\prod_{i=1}^{n} x_i$                   → JSON: "$\\prod_{i=1}^{n} x_i$"
$\int_{a}^{b} f(x)\,dx$                 → JSON: "$\\int_{a}^{b} f(x)\\,dx$"
$\lim_{x \to \infty} f(x)$              → JSON: "$\\lim_{x \\to \\infty} f(x)$"
```

### 4.5 Matrices y environments

**bmatrix** (corchetes):
```
$$\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$$
```
JSON:
```json
"$$\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}$$"
```

**pmatrix** (paréntesis):
```
$$\begin{pmatrix} a & b \\ c & d \end{pmatrix}$$
```

**cases** (funciones a trozos):
```
$$f(x) = \begin{cases} 1 & x > 0 \\ 0 & x \leq 0 \end{cases}$$
```
JSON:
```json
"$$f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\leq 0 \\end{cases}$$"
```

**aligned** (ecuaciones alineadas):
```
$$\begin{aligned} a &= b + c \\ d &= e + f \end{aligned}$$
```
JSON:
```json
"$$\\begin{aligned} a &= b + c \\\\ d &= e + f \\end{aligned}$$"
```

### 4.6 Texto dentro de fórmulas

Usa `\text{...}` para insertar texto normal dentro de una fórmula:

```
$P(\text{spam} \mid \text{palabra})$
```
JSON:
```json
"$P(\\text{spam} \\mid \\text{palabra})$"
```

**NO uses** `\textbf{}` para negrita en math; usa `\mathbf{}`:
```
$\mathbf{x} \in \mathbb{R}^n$
```

### 4.7 Decoradores

| Renderiza | Escribes | En JSON |
|---|---|---|
| x̂ (estimador) | `\hat{x}` | `\\hat{x}` |
| x̄ (media) | `\bar{x}`, `\overline{x}` | `\\bar{x}`, `\\overline{x}` |
| x̃ (tilde) | `\tilde{x}` | `\\tilde{x}` |
| ẋ (punto) | `\dot{x}` | `\\dot{x}` |
| x→ (vector) | `\vec{x}` | `\\vec{x}` |

### 4.8 Decimales con coma (formato español)

KaTeX interpreta la coma como separador de argumentos. Para usarla como separador decimal al estilo español, envuélvela en llaves:

```
$0{,}5$       ← correcto: renderiza 0,5
$0,5$         ← incorrecto: renderiza 0 5 (con espacio)
```

JSON:
```json
"$P = 0{,}5$"      →  "$P = 0{,}5$"   (se ve: P = 0,5)
```

---

## 5. Errores Comunes de LLMs y Cómo Evitarlos

### ❌ Error 1: Escape incorrecto en JSON

```json
// MAL: \frac sin escapar → JSON inválido o \f = form feed
{"prompt": "$\frac{1}{2}$"}

// MAL: cuádruple barra → doble backslash en el string → KaTeX ve \\frac
{"prompt": "$\\\\frac{1}{2}$"}

// BIEN: doble barra → una barra en el string → KaTeX ve \frac
{"prompt": "$\\frac{1}{2}$"}
```

### ❌ Error 2: Markdown compite con LaTeX

El subíndice `_` de LaTeX puede interferir con la cursiva de Markdown si está fuera de `$...$`:

```json
// MAL: el _ fuera de $ se interpreta como cursiva Markdown
{"prompt": "La variable x_i es importante y $y_j$ también"}
//         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ Markdown ve _i es...y $y_ como cursiva

// BIEN: envolver TODO lo que tenga _ en delimitadores math
{"prompt": "La variable $x_i$ es importante y $y_j$ también"}
```

### ❌ Error 3: Usar `\\` para newline en display math sin environment

```json
// MAL: \\ suelto en display math (KaTeX lo ignora con warning)
{"prompt": "$$a = 1 \\\\ b = 2$$"}

// BIEN: usar un environment aligned
{"prompt": "$$\\begin{aligned} a &= 1 \\\\ b &= 2 \\end{aligned}$$"}

// BIEN: usar dos bloques display separados
{"prompt": "$$a = 1$$\n$$b = 2$$"}
```

### ❌ Error 4: Olvidar cerrar delimitadores

```json
// MAL: $ sin cerrar → el texto posterior se come como "math"
{"prompt": "El coste es $50 por unidad"}

// BIEN: si NO es math, no usar $
{"prompt": "El coste es 50 por unidad"}

// BIEN: si ES math, cerrar el $
{"prompt": "El coste es $50$ por unidad"}
```

### ❌ Error 5: Poner Markdown dentro de delimitadores math

```json
// MAL: **negrita** dentro de $ → KaTeX no entiende asteriscos
{"prompt": "$**x** = 5$"}

// BIEN: usar \mathbf dentro de math
{"prompt": "$\\mathbf{x} = 5$"}

// BIEN: poner la negrita fuera del math
{"prompt": "**x** $= 5$"}
```

### ❌ Error 6: Usar comandos LaTeX no soportados por KaTeX

KaTeX no soporta todos los paquetes LaTeX. Comandos NO soportados incluyen:
- `\usepackage`, `\newcommand` (definiciones)
- `\includegraphics` (imágenes)
- `\label`, `\ref` (referencias cruzadas)
- `\eqref` (sin configuración adicional)

### ❌ Error 7: Salto de línea `\n` vs `\\n` en JSON

```json
// MAL: \n en JSON es un salto de línea REAL, no la secuencia \n de LaTeX
{"prompt": "$$a\nb$$"}
// El string resultante tiene un salto de línea real entre a y b

// BIEN: si quieres un salto de línea Markdown (párrafo nuevo):
{"prompt": "Primera línea.\n\nSegunda línea."}

// BIEN: si quieres \n de LaTeX (newline en math), probablemente quieres \\:
{"prompt": "$$\\begin{aligned} a &= 1 \\\\ b &= 2 \\end{aligned}$$"}
```

### ❌ Error 8: Mezclar estilos de delimitadores inconsistentemente

```json
// MAL: abre con \( y cierra con $
{"prompt": "\\(x = 5$"}

// BIEN: ser consistente
{"prompt": "$x = 5$"}
```

---

## 6. Formato Específico por Tipo de Pregunta

### 6.1 TEST (opción múltiple)

```json
{
  "type": "TEST",
  "prompt": "¿Cuál es el valor de $\\frac{d}{dx}(x^2)$?",
  "options": [
    {"id": "a", "text": "$2x$"},
    {"id": "b", "text": "$x^2$"},
    {"id": "c", "text": "$2$"},
    {"id": "d", "text": "$x$"}
  ],
  "correctOptionIds": ["a"],
  "explanation": "La derivada de $x^2$ es $2x$ aplicando la regla de la potencia: $\\frac{d}{dx}(x^n) = nx^{n-1}$.",
  "difficulty": 2,
  "tags": ["derivadas", "cálculo"],
  "topicKey": "slug-del-tema"
}
```

**Notas para opciones:**
- Las opciones también soportan Markdown + KaTeX
- Si una opción es solo una fórmula, envuélvela en `$...$`: `{"id": "a", "text": "$2x$"}`
- Si es texto + fórmula, mézclalos: `{"id": "a", "text": "El valor $2x$ cuando $t > 0$"}`

### 6.2 DESARROLLO (respuesta libre)

```json
{
  "type": "DESARROLLO",
  "prompt": "Explica el teorema de Bayes y su aplicación en clasificación de texto.",
  "modelAnswer": "El teorema de Bayes establece:\n\n$$P(A|B) = \\frac{P(B|A) \\cdot P(A)}{P(B)}$$\n\nEn clasificación de texto (e.g., detección de spam), se usa como:\n\n$$P(\\text{spam}|\\text{palabras}) = \\frac{P(\\text{palabras}|\\text{spam}) \\cdot P(\\text{spam})}{P(\\text{palabras})}$$\n\nDonde $P(\\text{palabras}|\\text{spam})$ se estima con frecuencias del corpus de entrenamiento.",
  "keywords": ["Bayes", "probabilidad condicional", "clasificación"],
  "difficulty": 3,
  "topicKey": "slug-del-tema"
}
```

### 6.3 COMPLETAR (rellenar huecos)

```json
{
  "type": "COMPLETAR",
  "prompt": "Completa los huecos sobre regularización en regresión.",
  "clozeText": "La regularización {{b1}} añade el término $\\lambda \\sum |w_i|$ a la función de coste, mientras que {{b2}} añade $\\lambda \\sum w_i^2$. El parámetro $\\lambda$ controla la {{b3}} de la penalización.",
  "blanks": [
    {"id": "b1", "accepted": ["L1", "Lasso", "lasso", "l1"]},
    {"id": "b2", "accepted": ["L2", "Ridge", "ridge", "l2"]},
    {"id": "b3", "accepted": ["intensidad", "fuerza", "magnitud"]}
  ],
  "difficulty": 3,
  "topicKey": "slug-del-tema"
}
```

**Notas para COMPLETAR:**
- Los huecos se marcan con `{{id}}` en `clozeText`
- Los IDs van: `b1`, `b2`, `b3`... en orden de aparición
- `accepted` incluye variantes (con/sin tilde, mayúsculas/minúsculas)
- El LaTeX en `clozeText` se renderiza normalmente (los `{{b1}}` se sustituyen por inputs)

### 6.4 PRACTICO (respuesta numérica)

```json
{
  "type": "PRACTICO",
  "prompt": "Dado un vocabulario de 250 palabras, si «buen» aparece 100 veces y «buen amigo» aparece 20 veces, calcula $P(\\text{amigo}|\\text{buen})$ con suavizado add-$k$ ($k=5$).",
  "modelAnswer": "Aplicamos la fórmula de suavizado add-$k$:\n\n$$P(w_i|w_{i-1}) = \\frac{C(w_{i-1}, w_i) + k}{C(w_{i-1}) + k \\cdot V}$$\n\nSustituyendo:\n\n$$P(\\text{amigo}|\\text{buen}) = \\frac{20 + 5}{100 + 5 \\cdot 250} = \\frac{25}{1350} \\approx 0{,}019$$",
  "numericAnswer": "0.019",
  "keywords": ["suavizado", "add-k", "n-gramas"],
  "difficulty": 4,
  "topicKey": "slug-del-tema"
}
```

---

## 7. Patrones JSON Completos de Referencia

### 7.1 Pregunta con matriz

```json
{
  "type": "TEST",
  "prompt": "Dada la matriz:\n\n$$A = \\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}$$\n\n¿Cuál es $\\det(A)$?",
  "options": [
    {"id": "a", "text": "$-2$"},
    {"id": "b", "text": "$2$"},
    {"id": "c", "text": "$-1$"},
    {"id": "d", "text": "$10$"}
  ],
  "correctOptionIds": ["a"],
  "explanation": "$$\\det(A) = 1 \\cdot 4 - 2 \\cdot 3 = 4 - 6 = -2$$"
}
```

### 7.2 Pregunta con función a trozos

```json
{
  "type": "DESARROLLO",
  "prompt": "Determina si la siguiente función es continua en $x = 0$:\n\n$$f(x) = \\begin{cases} x^2 + 1 & \\text{si } x \\geq 0 \\\\ -x + 1 & \\text{si } x < 0 \\end{cases}$$",
  "modelAnswer": "Evaluamos los límites laterales:\n\n$$\\lim_{x \\to 0^+} f(x) = 0^2 + 1 = 1$$\n$$\\lim_{x \\to 0^-} f(x) = -0 + 1 = 1$$\n$$f(0) = 0^2 + 1 = 1$$\n\nComo ambos límites coinciden con $f(0)$, la función **es continua** en $x = 0$.",
  "keywords": ["continuidad", "límites laterales"]
}
```

### 7.3 Pregunta con tabla de verdad

```json
{
  "type": "TEST",
  "prompt": "La siguiente tabla de verdad corresponde a:\n\n$$\\begin{array}{c|c|c} p & q & ? \\\\\\hline V & V & V \\\\ V & F & F \\\\ F & V & F \\\\ F & F & V \\end{array}$$",
  "options": [
    {"id": "a", "text": "$p \\Leftrightarrow q$"},
    {"id": "b", "text": "$p \\Rightarrow q$"},
    {"id": "c", "text": "$p \\land q$"},
    {"id": "d", "text": "$p \\lor q$"}
  ],
  "correctOptionIds": ["a"],
  "explanation": "La bicondicional $p \\Leftrightarrow q$ es verdadera cuando ambos operandos tienen el mismo valor de verdad."
}
```

### 7.4 Pregunta con ecuaciones alineadas

```json
{
  "type": "PRACTICO",
  "prompt": "Calcula la precisión y el recall dado: TP=80, FP=20, FN=10.",
  "modelAnswer": "$$\\begin{aligned} \\text{Precision} &= \\frac{TP}{TP + FP} = \\frac{80}{80 + 20} = \\frac{80}{100} = 0{,}8 \\\\ \\text{Recall} &= \\frac{TP}{TP + FN} = \\frac{80}{80 + 10} = \\frac{80}{90} \\approx 0{,}889 \\end{aligned}$$",
  "numericAnswer": "0.8",
  "keywords": ["precisión", "recall", "métricas"]
}
```

---

## 8. Checklist de Validación

Antes de entregar el JSON, verifica:

- [ ] **Cada `\` de LaTeX** tiene su escape `\\` en JSON
- [ ] **Los `\\` de LaTeX** (newline en math) son `\\\\` en JSON
- [ ] **Los `$` están emparejados**: cada `$` de apertura tiene su `$` de cierre
- [ ] **Los `$$` están emparejados**: cada `$$` de apertura tiene su `$$` de cierre
- [ ] **Los subíndices `_`** están dentro de `$...$`, no sueltos en texto
- [ ] **Las llaves `{}`** están balanceadas dentro de cada expresión math
- [ ] **Los environments** (`\begin{...}`) tienen su correspondiente `\end{...}`
- [ ] **Los separadores decimales** españoles usan `{,}` no `,` sola
- [ ] **No hay `$` sin cerrar** que pueda comerse el texto siguiente
- [ ] **El JSON es válido**: usa `JSON.parse()` mentalmente; `\f`, `\b`, `\t` son caracteres de control, no comandos LaTeX

---

## 9. Resumen Rápido

```
INLINE MATH:      $...$           JSON: "$...$"
DISPLAY MATH:     $$...$$         JSON: "$$...$$"
FRACCIÓN:         \frac{a}{b}     JSON: "\\frac{a}{b}"
SUMA:             \sum_{i}^{n}    JSON: "\\sum_{i}^{n}"
LETRA GRIEGA:     \alpha          JSON: "\\alpha"
SUBÍNDICE:        x_i             JSON: "x_i"  (siempre dentro de $...$)
SUPERÍNDICE:      x^2             JSON: "x^2"  (siempre dentro de $...$)
NEWLINE EN MATH:  \\              JSON: "\\\\"
NEGRITA MATH:     \mathbf{x}      JSON: "\\mathbf{x}"
TEXTO EN MATH:    \text{spam}     JSON: "\\text{spam}"
DECIMAL ESPAÑOL:  0{,}5           JSON: "0{,}5"
SALTO MARKDOWN:   (nueva línea)   JSON: "\\n"
```
