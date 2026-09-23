export const STATE_LABEL = { new: "Nueva", learning: "Aprendiendo", review: "Repaso", lapsed: "Olvidada" };

export const STATE_CHIP = { new: "chip-accent", learning: "chip-warn", review: "chip-ok", lapsed: "chip-danger" };

export const GRADE_LABEL = { 0: "Otra vez", 1: "Difícil", 2: "Bien", 3: "Fácil" };

export const GRADE_KEYS = { 1: 0, 2: 1, 3: 2, 4: 3 }; // keyboard 1-4 -> grade 0-3

export function when(epoch) {
  if (!epoch) return "—";
  const date = new Date(epoch * 1000);
  return date.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function dueLabel(epoch, nowMs = Date.now()) {
  if (!epoch) return "—";
  const diffMs = epoch * 1000 - nowMs;
  if (diffMs <= 0) return "ahora";
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) return `en ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `en ${hours} h`;
  const days = Math.round(hours / 24);
  return `en ${days} d`;
}

export function pct(value) {
  if (value == null) return "—";
  return `${Math.round(value * 100)}%`;
}

export function fold(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
