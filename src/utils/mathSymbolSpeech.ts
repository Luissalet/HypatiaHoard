/**
 * mathSymbolSpeech.ts
 *
 * Convierte símbolos matemáticos Unicode (extraídos por pdfjs de PDFs)
 * a texto hablado en español para TTS.
 */

// Mapa de símbolo Unicode → texto hablado en español
const MATH_SPEECH_MAP: Record<string, string> = {
  // Letras griegas (mayúsculas)
  'Α': 'alfa mayúscula', 'Β': 'beta mayúscula', 'Γ': 'gamma mayúscula',
  'Δ': 'delta mayúscula', 'Ε': 'épsilon mayúscula', 'Ζ': 'dseta mayúscula',
  'Η': 'eta mayúscula', 'Θ': 'zeta mayúscula', 'Ι': 'iota mayúscula',
  'Κ': 'kappa mayúscula', 'Λ': 'lambda mayúscula', 'Μ': 'mu mayúscula',
  'Ν': 'nu mayúscula', 'Ξ': 'xi mayúscula', 'Ο': 'ómicron mayúscula',
  'Π': 'pi mayúscula', 'Ρ': 'ro mayúscula', 'Σ': 'sigma mayúscula',
  'Τ': 'tau mayúscula', 'Υ': 'ípsilon mayúscula', 'Φ': 'fi mayúscula',
  'Χ': 'ji mayúscula', 'Ψ': 'psi mayúscula', 'Ω': 'omega mayúscula',

  // Letras griegas (minúsculas)
  'α': 'alfa', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta',
  'ε': 'épsilon', 'ζ': 'dseta', 'η': 'eta', 'θ': 'zeta',
  'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu',
  'ν': 'nu', 'ξ': 'xi', 'ο': 'ómicron', 'π': 'pi',
  'ρ': 'ro', 'σ': 'sigma', 'ς': 'sigma final', 'τ': 'tau',
  'υ': 'ípsilon', 'φ': 'fi', 'χ': 'ji', 'ψ': 'psi', 'ω': 'omega',

  // Operadores básicos
  '±': 'más menos', '∓': 'menos más', '×': 'por', '÷': 'dividido entre',
  '·': 'punto', '∘': 'composición',

  // Relaciones
  '≈': 'aproximadamente igual a', '≠': 'distinto de', '≡': 'idéntico a',
  '≤': 'menor o igual que', '≥': 'mayor o igual que',
  '≪': 'mucho menor que', '≫': 'mucho mayor que',
  '∝': 'proporcional a', '≅': 'congruente con', '∼': 'similar a',
  '≜': 'definido como',

  // Conjuntos y lógica
  '∈': 'pertenece a', '∉': 'no pertenece a',
  '⊂': 'subconjunto de', '⊃': 'superconjunto de',
  '⊆': 'subconjunto o igual a', '⊇': 'superconjunto o igual a',
  '∪': 'unión', '∩': 'intersección',
  '∅': 'conjunto vacío', '∁': 'complemento',
  '∀': 'para todo', '∃': 'existe', '∄': 'no existe',
  '¬': 'no', '∧': 'y lógico', '∨': 'o lógico',
  '⊕': 'o exclusivo', '⊗': 'producto tensorial',
  '⟹': 'implica', '⟸': 'es implicado por', '⟺': 'si y solo si',
  '→': 'flecha derecha', '←': 'flecha izquierda', '↔': 'doble flecha',
  '⇒': 'implica', '⇐': 'es implicado por', '⇔': 'si y solo si',

  // Cálculo y análisis
  '∑': 'sumatorio', '∏': 'productorio',
  '∫': 'integral', '∬': 'integral doble', '∭': 'integral triple',
  '∮': 'integral de línea cerrada',
  '∂': 'derivada parcial', '∇': 'nabla',
  '√': 'raíz cuadrada de', '∛': 'raíz cúbica de',
  '∞': 'infinito', 'ℵ': 'álef',

  // Misceláneos
  '°': 'grados', '′': 'prima', '″': 'doble prima',
  '‖': 'norma', '⟨': 'ángulo izquierdo', '⟩': 'ángulo derecho',
  'ℝ': 'reales', 'ℕ': 'naturales', 'ℤ': 'enteros',
  'ℚ': 'racionales', 'ℂ': 'complejos',
  '⊥': 'perpendicular', '∠': 'ángulo', '∥': 'paralelo',
  '⊤': 'tautología',
  '†': 'daga', '‡': 'doble daga',
  'ℓ': 'ele cursiva',
};

// Patrones comunes en PDFs de IA/ML
const PATTERN_REPLACEMENTS: [RegExp, string | ((...args: string[]) => string)][] = [
  // Subíndices y superíndices numéricos
  [/([a-zA-Zα-ωΑ-Ω])₀/g, '$1 sub cero'],
  [/([a-zA-Zα-ωΑ-Ω])₁/g, '$1 sub uno'],
  [/([a-zA-Zα-ωΑ-Ω])₂/g, '$1 sub dos'],
  [/([a-zA-Zα-ωΑ-Ω])₃/g, '$1 sub tres'],
  [/([a-zA-Zα-ωΑ-Ω])ₙ/g, '$1 sub ene'],
  [/([a-zA-Zα-ωΑ-Ω])ᵢ/g, '$1 sub i'],
  [/([a-zA-Zα-ωΑ-Ω])ⱼ/g, '$1 sub jota'],
  [/([a-zA-Zα-ωΑ-Ω])²/g, '$1 al cuadrado'],
  [/([a-zA-Zα-ωΑ-Ω])³/g, '$1 al cubo'],
  [/([a-zA-Zα-ωΑ-Ω])ⁿ/g, '$1 elevado a ene'],

  // Fracciones Unicode comunes
  [/½/g, 'un medio'],
  [/⅓/g, 'un tercio'],
  [/¼/g, 'un cuarto'],
  [/¾/g, 'tres cuartos'],

  // Notación R^n, R^d, etc.
  [/ℝ([⁰¹²³⁴⁵⁶⁷⁸⁹ⁿᵈᵐᵏ]+)/g, (_: string, sup: string) => `reales de dimensión ${superscriptToText(sup)}`],
];

function superscriptToText(sup: string): string {
  const map: Record<string, string> = {
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
    '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
    'ⁿ': 'ene', 'ᵈ': 'de', 'ᵐ': 'eme', 'ᵏ': 'ka',
  };
  return [...sup].map((c) => map[c] ?? c).join('');
}

/**
 * Convierte símbolos matemáticos Unicode en texto hablado en español.
 */
export function mathToSpeech(text: string): string {
  let result = text;

  // Aplicar patrones primero (son más específicos)
  for (const [pattern, replacement] of PATTERN_REPLACEMENTS) {
    if (typeof replacement === 'string') {
      result = result.replace(pattern, replacement);
    } else {
      result = result.replace(pattern, replacement as (...args: string[]) => string);
    }
  }

  // Sustituir símbolos individuales
  for (const [symbol, speech] of Object.entries(MATH_SPEECH_MAP)) {
    result = result.split(symbol).join(` ${speech} `);
  }

  // Limpiar espacios múltiples
  result = result.replace(/\s{2,}/g, ' ').trim();

  return result;
}
