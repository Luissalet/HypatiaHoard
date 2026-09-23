---
name: Hypatia's Hoard
description: Tarjetas de repaso espaciado del usuario, rellenadas por el asistente y repasadas en la aplicación.
colors:
  accent: "#1f5e3a"
  accent-hover: "#17472c"
  accent-soft: "#e2f2e7"
  accent-light: "#4fb27a"
  ink: "#22281f"
  muted: "#5f6b60"
  paper: "#f6f9f6"
  white: "#ffffff"
  line: "#dde7de"
  soft: "#eef4ef"
  sidebar: "#eff5f0"
  nav-active: "#d8ecdd"
  nav-active-ink: "#17472c"
  nav-hover: "#e7f0e8"
  field-line: "#cfe0d2"
  field-ink: "#223226"
  placeholder: "#8a9a8d"
  supporting-ink: "#57685c"
  focus: "#2f7a4e"
  button-line: "#d5e2d7"
  panel: "#eef4ee"
  ok-bg: "#e5efe4"
  ok-ink: "#2f5f3a"
  warn-bg: "#f8ecd2"
  warn-ink: "#7a5a17"
  danger-bg: "#f9e8e6"
  danger-ink: "#8a2f26"
  danger-line: "#eac6c1"
  bar-bg: "#dfe9e0"
  highlight: "#f7e7a7"
  quote: "#1f5e3a"
typography:
  headline:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: 1.65
  card-text:
    fontFamily: "Georgia, Times New Roman, serif"
    fontSize: "20px"
    lineHeight: 1.6
  button:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "18px"
  label:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
  code:
    fontFamily: "Consolas, monospace"
    fontSize: "12px"
rounded:
  badge: "5px"
  field: "6px"
  control: "7px"
  panel: "8px"
  card: "10px"
spacing:
  control-gap: "8px"
  action-gap: "10px"
  page-gutter: "40px"
  page-gutter-mobile: "16px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  field:
    backgroundColor: "{colors.white}"
    textColor: "{colors.field-ink}"
    rounded: "{rounded.field}"
    padding: "8px 11px"
  review-card:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.card}"
    padding: "36px 28px"
  grade-button:
    rounded: "{rounded.control}"
    minHeight: "56px"
  chip:
    typography: "10px / 600 / uppercase"
    rounded: "{rounded.badge}"
    padding: "2px 6px"
---

# Design System: Hypatia's Hoard

## Overview

**Creative North Star: "Cuaderno de repaso"**

Un cuaderno de fichas, tranquilo y sin distracciones: una pregunta a la vez, el tiempo justo para responder, y una respuesta clara antes de calificar. Papel muy claro, tinta oscura y un acento esmeralda reservado a la acción principal, la ficha en repaso y el estado activo. El frente y el reverso de la tarjeta se componen en serifa (Georgia) para separar «lo que hay que recordar» de la interfaz que lo administra; todo lo demás va en Segoe UI. Interfaz en español de España.

**Key Characteristics:**

- Una tarjeta grande y centrada por sesión: nada compite con la pregunta.
- El reverso solo aparece tras pulsar «Mostrar respuesta» — nunca antes.
- Cuatro botones de calificación con color semántico (otra vez, difícil, bien, fácil) y atajos de teclado 1-4.
- Estados escritos (nueva, aprendiendo, repaso, olvidada) en vez de iconos.

## Colors

### Primary

- `accent` #1f5e3a (esmeralda oscuro) para el botón primario, la ficha nueva y el estado activo de navegación.
- `accent-hover` #17472c y `accent-soft` #e2f2e7 (chips, fondos suaves).
- `accent-light` #4fb27a como acento claro para barras y detalles secundarios.

### Neutral

- `paper` #f6f9f6 fondo; `white` paneles y filas; `sidebar` #eff5f0; `panel` #eef4ee formularios.
- `ink` #22281f texto; `supporting-ink` #57685c ayudas; `line` #dde7de bordes.
- Semánticos: `ok` verde apagado (bien/fácil, racha activa), `warn` ámbar (difícil, olvidada a medias), `danger` (otra vez, eliminar).

## Typography

**Body Font:** Segoe UI (system-ui de respaldo). **Frente y reverso de la tarjeta:** Georgia, 20px/1.6, con saltos de línea propios (`white-space: pre-wrap`).

- **Headline:** título de página 30px (26px en móvil).
- **Title:** títulos de sección 16px seminegrita.
- **Body:** 14px; ayudas y metadatos 12px; chips 10px mayúsculas.

## Layout

Escritorio: índice fijo de 224px + contenido flexible (`min-width: 0`), márgenes de 40px. Repasar limita el ancho a 720px y centra la tarjeta. Tarjetas lista filas con filtros arriba. Mazos usa una cuadrícula de tarjetas de 2 columnas. Estadísticas usa una cuadrícula de contadores + dos paneles + previsión de barras.

- Hasta 768px: el índice pasa a barra superior con navegación horizontal desplazable; márgenes de 16px; los botones de calificación ocupan todo el ancho en una fila de 4.
- No hay desplazamiento horizontal de página a 390px: todo contenedor de cuadrícula lleva `min-width: 0`.

## Elevation & Depth

Plano por defecto. Sombras solo en el aviso flotante (toast). La tarjeta en repaso se distingue por tamaño y centrado, no por sombra.

## Shapes

Campos 6px, controles 7px, paneles 8px, la tarjeta de repaso 10px, chips 5px. Bordes de 1px. Iconos SVG de línea. Sin imágenes raster salvo los iconos de instalación (PWA).

## Components

### Buttons

Primario (esmeralda), secundario (blanco con borde), peligro (rojo suave: «Eliminar»). Altura mínima 38px; variante `btn-sm` de 30px para acciones de fila. Los cuatro botones de calificación son un componente propio (`grade-btn`) con color semántico y el atajo de teclado visible en pequeño.

### Inputs / Fields

Etiqueta encima, ayuda debajo. El selector de mazo es un `<select>` simple en la cabecera de cada página que lo necesita.

### Navigation

Cuatro secciones: Repasar, Tarjetas, Mazos, Estadísticas. Rutas por hash (`#/repasar`, `#/tarjetas`). La activa usa `aria-current` con fondo `nav-active`; Repasar muestra un contador de pendientes en un chip.

### Review card

Tarjeta blanca centrada con el frente en serifa grande; tras revelar, un separador punteado y el reverso más pequeño, con la fuente debajo en texto de ayuda. Barra de progreso fina encima («N de M pendientes»).

### Chips

Estado de la tarjeta (nueva/aprendiendo/repaso/olvidada), etiquetas, «suspendida». Texto en mayúsculas de 10px.

### Empty states

Un título, una frase y una única acción («Nueva tarjeta», «Nuevo mazo», «Añadir tarjetas»).

## Do's and Don'ts

### Do:

- **Do** mantener el reverso oculto hasta que el usuario pulsa «Mostrar respuesta» — ficha nueva sin trampas.
- **Do** mostrar la fuente de cada tarjeta cuando exista; es lo que hace la ficha verificable.
- **Do** dejar el atajo de teclado visible en los botones de calificación.
- **Do** escribir los estados con palabras (nueva, aprendiendo, repaso, olvidada), nunca solo con color.

### Don't:

- **Don't** convertir la tarjeta de repaso en una tarjeta elevada con sombra.
- **Don't** usar el acento para texto largo; reservarlo a la acción principal, el chip de pendientes y el estado activo.
- **Don't** revelar el reverso, ni total ni parcialmente, antes de que el usuario pulse el botón o la barra espaciadora.
