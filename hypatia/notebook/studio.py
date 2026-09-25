"""Studio: generated study material from a subject's sources, run as background jobs.

Kinds: study_guide, briefing, faq, glossary, timeline, mindmap, podcast. Big material is
map-reduced (groups of ≤ ~12k chars → notes that keep `[n]` markers → composition), so
citations always point at real chunks.
"""

from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from ..hashing import compute_concept_hash, compute_content_hash
from . import llm, mindmap, podcast, retrieval
from .schema import row, rows

KINDS: dict[str, str] = {
    "study_guide": "Guía de estudio",
    "briefing": "Documento informativo",
    "faq": "Preguntas frecuentes",
    "glossary": "Glosario",
    "timeline": "Cronología",
    "mindmap": "Mapa mental",
    "podcast": "Resumen en audio",
}
JSON_KINDS = {"faq", "glossary", "mindmap", "podcast"}
GROUP_CHARS = 12_000
DIRECT_CHARS = 14_000
MAX_GROUPS = 16
REDUCE_CHARS = 16_000
DEGRADED_MATERIAL_CHARS = 30_000


class Stopped(Exception):
    """The worker is shutting down; the job goes back to 'queued'."""


# ---------------------------------------------------------------- prompts

_COMMON = """Trabajas SOLO con el material dado (pasajes numerados o notas con citas [n]); no inventes nada.
Cita con [n] (números de los pasajes) tras cada afirmación importante; usa solo números que aparezcan en el material.
Escribe en español claro y didáctico, salvo que las indicaciones del estudiante pidan otro idioma. LaTeX con $...$ si hay fórmulas."""

KIND_FOCUS = {
    "study_guide": "conceptos clave, definiciones, relaciones, procedimientos y fórmulas, y lo más preguntable en un examen",
    "briefing": "ideas principales, conclusiones, datos relevantes y citas destacables",
    "faq": "preguntas que un estudiante se haría y sus respuestas",
    "glossary": "términos técnicos y sus definiciones exactas",
    "timeline": "fechas, etapas, secuencias, evolución histórica o pasos de procesos, y sus protagonistas",
    "mindmap": "la jerarquía de temas, subtemas e ideas",
    "podcast": "las ideas clave, ejemplos y explicaciones que den para una conversación",
}

COMPOSE = {
    "study_guide": """Redacta una GUÍA DE ESTUDIO en Markdown:
# <título>
## Resumen (5-8 líneas)
## Conceptos clave (definición breve de cada uno)
## Desarrollo (apartados ## / ### siguiendo la estructura del material)
## Fórmulas y procedimientos (si los hay)
## Puntos a vigilar (errores y confusiones frecuentes)
## Preguntas de repaso (8-12 preguntas cortas con su respuesta breve)""",
    "briefing": """Redacta un DOCUMENTO INFORMATIVO (briefing) en Markdown:
# <título>
## Resumen ejecutivo (un párrafo)
## Temas principales (cada uno con 2-4 viñetas)
## Ideas y datos clave
## Citas destacadas (frases literales breves del material, entre comillas, con su [n])
## Conclusiones""",
    "timeline": """Redacta una CRONOLOGÍA en Markdown:
# <título>
## Cronología (lista ordenada: **fecha o etapa** — qué ocurre, con [n]). Si el material no tiene fechas, ordena la secuencia lógica/histórica de las ideas o los pasos de los procesos.
## Protagonistas y conceptos (autores, modelos, métodos que aparecen, una línea cada uno)""",
    "faq": """Escribe 8-15 PREGUNTAS FRECUENTES con respuesta (3-6 frases, citando [n]).
Devuelve SOLO JSON: {"title": "...", "items": [{"q": "...", "a": "... [n]"}]}""",
    "glossary": """Escribe un GLOSARIO de 10-40 términos técnicos del material, con definición precisa de 1-3 frases citando [n].
Devuelve SOLO JSON: {"title": "...", "items": [{"term": "...", "definition": "... [n]"}]}""",
    "mindmap": """Construye un MAPA MENTAL jerárquico: raíz = tema general; 3-7 ramas principales; hasta 4 niveles de profundidad; como mucho 60 nodos; etiquetas cortas (≤ 8 palabras). En cada nodo, "refs" con los números [n] de los pasajes que lo respaldan (lista de enteros, puede ir vacía).
Devuelve SOLO JSON: {"label": "...", "refs": [], "children": [{"label": "...", "refs": [1], "children": [...]}]}""",
}

MAP_SYSTEM = """Extraes notas de estudio fieles de pasajes numerados. Escribe viñetas concisas en español con lo relevante para: {focus}.
Tras cada viñeta pon las citas [n] de los pasajes de los que sale (solo números existentes). No inventes, no añadas preámbulos. Máximo unas 700 palabras."""

REDUCE_SYSTEM = """Condensas notas de estudio en viñetas más compactas (máximo unas 900 palabras) sin perder conceptos ni las citas [n] que llevan. No inventes, sin preámbulos."""


# ---------------------------------------------------------------- helpers

def _loads(v: Optional[str], default: Any) -> Any:
    if not v:
        return default
    try:
        return json.loads(v)
    except ValueError:
        return default


def public_item(r: dict[str, Any], *, full: bool = True) -> dict[str, Any]:
    out = {
        "id": r["id"], "subjectId": r["subject_id"], "kind": r["kind"], "title": r.get("title"),
        "scope": _loads(r.get("scope"), {}), "status": r["status"], "model": r.get("model"),
        "error": r.get("error"), "note": r.get("note"), "createdAt": r.get("created_at"),
        "finishedAt": r.get("finished_at"),
        "audioUrl": f"/api/notebook/studio/{r['id']}/audio" if r.get("audio_path") else None,
    }
    if full:
        out["content"] = r.get("content")
        out["data"] = _loads(r.get("data"), None)
        out["citations"] = _loads(r.get("citations"), [])
    return out


def get_item(services: Any, item_id: str) -> Optional[dict[str, Any]]:
    r = row(services, "SELECT * FROM studio_items WHERE id=?", (item_id,))
    return public_item(r) if r else None


def list_items(services: Any, subject_id: str, kind: Optional[str] = None) -> list[dict[str, Any]]:
    sql, params = "SELECT * FROM studio_items WHERE subject_id=?", [subject_id]
    if kind:
        sql += " AND kind=?"
        params.append(kind)
    return [public_item(r, full=False) for r in rows(services, sql + " ORDER BY created_at DESC", params)]


def delete_item(services: Any, item_id: str) -> bool:
    r = row(services, "SELECT audio_path FROM studio_items WHERE id=?", (item_id,))
    if not r:
        return False
    if r.get("audio_path"):
        try:
            Path(r["audio_path"]).unlink(missing_ok=True)
        except OSError:
            pass
    with services.db.tx() as conn:
        conn.execute("DELETE FROM studio_items WHERE id=?", (item_id,))
    return True


def audio_path(services: Any, item_id: str) -> Optional[Path]:
    r = row(services, "SELECT audio_path FROM studio_items WHERE id=?", (item_id,))
    if not r or not r.get("audio_path"):
        return None
    p = Path(r["audio_path"])
    return p if p.is_file() else None


def _update(services: Any, item_id: str, **fields: Any) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k}=?" for k in fields)
    with services.db.tx() as conn:
        conn.execute(f"UPDATE studio_items SET {cols} WHERE id=?", (*fields.values(), item_id))


def degraded_material(passages: list[dict[str, Any]], limit: int = DEGRADED_MATERIAL_CHARS
                      ) -> tuple[str, list[dict[str, Any]], bool]:
    """(text, included passages, truncated) for an assistant that composes by itself."""
    parts, used, total = [], [], 0
    for p in passages:
        block = retrieval.format_passages([p])
        if total + len(block) > limit:
            return "\n\n".join(parts), used, True
        parts.append(block)
        used.append(p)
        total += len(block) + 2
    return "\n\n".join(parts), used, False


# ---------------------------------------------------------------- create

def create(services: Any, subject_ref: str, kind: str, *, topic: Optional[str] = None,
           source_ids: Optional[list[str]] = None, instructions: Optional[str] = None,
           add_as_source: bool = False, title: Optional[str] = None) -> dict[str, Any]:
    """Queue a studio job. Without sources or without a model returns `{item: None, note, ...}`."""
    if kind not in KINDS:
        raise ValueError(f"Tipo desconocido «{kind}». Tipos: {', '.join(KINDS)}")
    subject = services.resolve_subject(subject_ref)
    sid = subject["id"]
    topic_obj = services.resolve_topic(sid, topic) if topic else None
    mat = retrieval.material(services, sid, topic=topic_obj["id"] if topic_obj else None, source_ids=source_ids)
    if not mat["passages"]:
        return {"item": None, "note": "No hay fuentes indexadas en este ámbito: añade o reescanea fuentes primero."}
    ok, _model, reason = llm.resolve(services, "llm")
    if not ok:
        text, used, truncated = degraded_material(mat["passages"])
        note = (f"{llm.NO_LLM_NOTE} ({reason}) Redacta tú el/la «{KINDS[kind]}» a partir de `material`, "
                "citando con [n] los pasajes (ver `citations`).")
        if truncated:
            note += " El material está recortado; usa notebook_search para ampliar."
        return {"item": None, "kind": kind, "material": text,
                "citations": [retrieval.citation(p) for p in used], "note": note}
    item_id = "st_" + uuid.uuid4().hex[:16]
    label = topic_obj.get("title") if topic_obj else subject.get("name")
    scope = {"topicId": topic_obj["id"] if topic_obj else None, "topicTitle": topic_obj.get("title") if topic_obj else None,
             "sourceIds": source_ids or None, "instructions": (instructions or "").strip() or None,
             "addAsSource": bool(add_as_source)}
    if mat["scope"].get("note"):
        scope["scopeNote"] = mat["scope"]["note"]
    with services.db.tx() as conn:
        conn.execute("INSERT INTO studio_items(id, subject_id, kind, title, scope, status, created_at)"
                     " VALUES(?,?,?,?,?,?,?)",
                     (item_id, sid, kind, title or f"{KINDS[kind]} · {label}", json.dumps(scope, ensure_ascii=False),
                      "queued", services.now_iso()))
    from . import worker

    worker.submit_studio(services, item_id)
    return {"item": get_item(services, item_id)}


def wait(services: Any, item_id: str, wait_s: float) -> Optional[dict[str, Any]]:
    import time

    deadline = time.monotonic() + max(0.0, min(float(wait_s), 120.0))
    while True:
        item = get_item(services, item_id)
        if not item or item["status"] in ("done", "error") or time.monotonic() >= deadline:
            return item
        time.sleep(0.25)


# ---------------------------------------------------------------- run

def run(services: Any, item_id: str, stop: Optional[threading.Event] = None) -> None:
    """Execute one queued job (called by the worker; safe to call inline in tests)."""
    r = row(services, "SELECT * FROM studio_items WHERE id=?", (item_id,))
    if not r or r["status"] not in ("queued", "running"):
        return
    _update(services, item_id, status="running", error=None)

    def check() -> None:
        if stop is not None and stop.is_set():
            raise Stopped()

    try:
        result = _generate(services, r, check)
    except Stopped:
        _update(services, item_id, status="queued")
        return
    except llm.NoModel as exc:
        _update(services, item_id, status="error", error=exc.note(), finished_at=services.now_iso())
        return
    except Exception as exc:  # noqa: BLE001 - recorded on the item
        _update(services, item_id, status="error", error=f"{exc.__class__.__name__}: {exc}"[:1000],
                finished_at=services.now_iso())
        return
    fields = {
        "status": result.get("status", "done"), "content": result.get("content"),
        "data": json.dumps(result["data"], ensure_ascii=False) if result.get("data") is not None else None,
        "citations": json.dumps(result.get("citations") or [], ensure_ascii=False),
        "model": result.get("model"), "note": result.get("note"), "error": result.get("error"),
        "audio_path": result.get("audioPath"), "finished_at": services.now_iso(),
    }
    if result.get("title"):
        fields["title"] = result["title"][:160]
    _update(services, item_id, **fields)
    scope = _loads(r.get("scope"), {})
    if scope.get("addAsSource") and fields["status"] == "done" and fields["content"]:
        try:
            add_as_source(services, item_id)
        except Exception:  # noqa: BLE001 - the item itself is done
            pass


class _Ctx:
    def __init__(self, services: Any, check: Callable[[], None]):
        self.services = services
        self.check = check
        self.model: Optional[str] = None
        self.notes: list[str] = []

    def chat(self, system: str, user: str, *, max_tokens: int = 3000, json_mode: bool = False,
             temperature: float = 0.3) -> str:
        self.check()
        reply = llm.chat(self.services, [{"role": "system", "content": system}, {"role": "user", "content": user}],
                         max_tokens=max_tokens, temperature=temperature, json_mode=json_mode)
        self.model = reply.model or self.model
        self.check()
        return reply.text

    def chat_json(self, system: str, user: str, *, max_tokens: int = 4000) -> Any:
        text = self.chat(system, user, max_tokens=max_tokens, json_mode=True)
        data = llm.parse_json(text)
        if data is None:
            text = self.chat(system + "\n\nIMPORTANTE: responde únicamente con JSON válido, sin texto alrededor.",
                             user, max_tokens=max_tokens, json_mode=True, temperature=0.1)
            data = llm.parse_json(text)
        if data is None:
            raise ValueError("El modelo no devolvió JSON válido")
        return data


def _groups(passages: list[dict[str, Any]], limit: int) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = [[]]
    size = 0
    for p in passages:
        n = len(p["text"]) + 80
        if groups[-1] and size + n > limit:
            groups.append([])
            size = 0
        groups[-1].append(p)
        size += n
    return [g for g in groups if g]


def prepare_context(ctx: _Ctx, passages: list[dict[str, Any]], kind: str) -> str:
    """The material the final prompt sees: raw passages when small, else map-reduced notes."""
    total = sum(len(p["text"]) + 80 for p in passages)
    if total <= DIRECT_CHARS:
        return "Pasajes del material:\n\n" + retrieval.format_passages(passages)
    groups = _groups(passages, GROUP_CHARS)
    if len(groups) > MAX_GROUPS:
        # keep an even sample of chunks so coverage stays uniform across the material
        keep = max(1, int(len(passages) * MAX_GROUPS / len(groups)))
        step = len(passages) / keep
        sample = [passages[int(i * step)] for i in range(keep)]
        ctx.notes.append(f"Material muy extenso: se ha usado una muestra de {keep} de {len(passages)} fragmentos; "
                         "elige un tema o fuentes concretas para cubrirlo entero.")
        groups = _groups(sample, GROUP_CHARS)[:MAX_GROUPS]
    system = MAP_SYSTEM.format(focus=KIND_FOCUS[kind])
    notes = [ctx.chat(system, "Pasajes:\n\n" + retrieval.format_passages(g), max_tokens=1800) for g in groups]
    for _ in range(3):
        joined = "\n\n".join(notes)
        if len(joined) <= REDUCE_CHARS:
            break
        packs: list[list[str]] = [[]]
        size = 0
        for n in notes:
            if packs[-1] and size + len(n) > GROUP_CHARS:
                packs.append([])
                size = 0
            packs[-1].append(n)
            size += len(n)
        notes = [ctx.chat(REDUCE_SYSTEM, "Notas:\n\n" + "\n\n".join(p), max_tokens=2000) for p in packs]
    return ("Notas extraídas del material (las citas [n] remiten a los pasajes originales):\n\n"
            + "\n\n".join(notes))


def _title_from_markdown(md: str) -> tuple[Optional[str], str]:
    lines = md.strip().splitlines()
    if lines and lines[0].startswith("# "):
        return lines[0][2:].strip() or None, md
    return None, md


def _generate(services: Any, item: dict[str, Any], check: Callable[[], None]) -> dict[str, Any]:
    kind = item["kind"]
    scope = _loads(item.get("scope"), {})
    mat = retrieval.material(services, item["subject_id"], topic=scope.get("topicId"),
                             source_ids=scope.get("sourceIds"))
    passages = mat["passages"]
    if not passages:
        raise ValueError("No hay fuentes indexadas en este ámbito")
    ctx = _Ctx(services, check)
    context = prepare_context(ctx, passages, kind)
    extra = f"\n\nIndicaciones del estudiante: {scope['instructions']}" if scope.get("instructions") else ""
    topic_line = f"Tema: {scope['topicTitle']}\n\n" if scope.get("topicTitle") else ""
    user = f"{topic_line}{context}{extra}"
    out: dict[str, Any] = {}

    if kind in ("study_guide", "briefing", "timeline"):
        md = ctx.chat(_COMMON + "\n\n" + COMPOSE[kind], user, max_tokens=4000)
        content, cites = retrieval.apply_citations(md, passages)
        title, content = _title_from_markdown(content)
        out.update(content=content, citations=cites, title=title)
    elif kind in ("faq", "glossary"):
        data = ctx.chat_json(_COMMON + "\n\n" + COMPOSE[kind], user, max_tokens=4000)
        items_raw = data.get("items") if isinstance(data, dict) else data
        if not isinstance(items_raw, list):
            items_raw = []
        a_key, q_key = ("a", "q") if kind == "faq" else ("definition", "term")
        items, all_cites, md = [], {}, [f"# {(data.get('title') if isinstance(data, dict) else None) or KINDS[kind]}", ""]
        for it in items_raw:
            if not isinstance(it, dict):
                continue
            q = str(it.get(q_key) or it.get("question") or it.get("pregunta") or it.get("término") or "").strip()
            a = str(it.get(a_key) or it.get("answer") or it.get("respuesta") or it.get("definición") or "").strip()
            if not q or not a:
                continue
            a_clean, cites = retrieval.apply_citations(a, passages)
            for c in cites:
                all_cites[c["n"]] = c
            items.append({q_key: q, a_key: a_clean, "citations": cites})
            md.append(f"### {q}\n\n{a_clean}\n" if kind == "faq" else f"- **{q}**: {a_clean}")
        if not items:
            raise ValueError("El modelo no devolvió elementos utilizables")
        out.update(data=items, content="\n".join(md).strip(), citations=[all_cites[n] for n in sorted(all_cites)],
                   title=(data.get("title") if isinstance(data, dict) else None))
    elif kind == "mindmap":
        raw = ctx.chat_json(_COMMON + "\n\n" + COMPOSE[kind], user, max_tokens=3000)
        tree = mindmap.validate(raw, [p["n"] for p in passages], fallback_label=scope.get("topicTitle") or "Mapa")
        valid = {p["n"]: p for p in passages}
        out.update(data=tree, content=mindmap.to_markdown(tree),
                   citations=[retrieval.citation(valid[n]) for n in mindmap.all_refs(tree) if n in valid])
    elif kind == "podcast":
        raw = ctx.chat_json(podcast.SCRIPT_SYSTEM, user, max_tokens=6000)
        script = podcast.normalize_script(raw, item.get("title") or KINDS[kind])
        if not script:
            raise ValueError("El modelo no devolvió un guion utilizable")
        out.update(data=script, content=podcast.script_markdown(script), title=script["title"], citations=[])
        check()
        target = Path(services.config.data_dir) / "studio" / f"{item['id']}.wav"
        audio = podcast.synthesize(services, script, target)
        if audio.get("audioPath"):
            out["audioPath"] = audio["audioPath"]
        if audio.get("note"):
            ctx.notes.append(audio["note"])
        if audio.get("error"):
            out["status"] = "error"
            out["error"] = audio["error"]
        words = podcast.word_count(script)
        if words < 900:
            ctx.notes.append(f"Guion más corto de lo previsto ({words} palabras).")
    else:  # pragma: no cover - guarded in create()
        raise ValueError(kind)
    if scope.get("scopeNote"):
        ctx.notes.append(scope["scopeNote"])
    out["model"] = ctx.model
    out["note"] = " ".join(ctx.notes) or None
    return out


# ---------------------------------------------------------------- conversions

def _item_row(services: Any, item_id: str) -> dict[str, Any]:
    r = row(services, "SELECT * FROM studio_items WHERE id=?", (item_id,))
    if not r:
        raise LookupError(f"No existe el elemento de estudio {item_id}")
    if r["status"] != "done" or not r.get("data"):
        raise ValueError("El elemento aún no está terminado")
    return r


def _source_line(cites: list[dict[str, Any]]) -> str:
    if not cites:
        return ""
    c = cites[0]
    return f"Fuente: {c['filename']}" + (f", p. {c['page']}" if c.get("page") else "")


def to_concepts(services: Any, item_id: str) -> dict[str, Any]:
    """Glossary → keyConcepts (category 'definition'), deduplicated by concept hash."""
    r = _item_row(services, item_id)
    if r["kind"] != "glossary":
        raise ValueError("Solo un glosario se puede convertir en conceptos clave")
    scope = _loads(r.get("scope"), {})
    sid = r["subject_id"]
    existing = [c for c in services.store.list("keyConcept", sid) if c.get("category") == "definition"]
    order = max([int(c.get("order") or 0) for c in existing] + [-1]) + 1
    added, skipped = [], 0
    for it in _loads(r["data"], []):
        title = str(it.get("term") or "").strip()
        body = retrieval.strip_markers(str(it.get("definition") or ""))
        if not title or not body:
            continue
        src = _source_line(it.get("citations") or [])
        content = body + (f"\n\n*{src}*" if src else "")
        h = compute_concept_hash("definition", title, content)
        if services.store.by_hash("keyConcept", h) or any(
                (c.get("title") or "").strip().lower() == title.lower() for c in existing):
            skipped += 1
            continue
        now = services.now_iso()
        concept = {"id": str(uuid.uuid4()), "subjectId": sid, "category": "definition", "title": title,
                   "content": content, "tags": ["cuaderno"], "order": order, "contentHash": h,
                   "createdAt": now, "updatedAt": now}
        if scope.get("topicId"):
            concept["topicId"] = scope["topicId"]
        services.store.put("keyConcept", concept)
        existing.append(concept)
        added.append(concept["id"])
        order += 1
    return {"added": len(added), "skipped": skipped, "ids": added}


def _topic_for_questions(services: Any, sid: str, scope: dict[str, Any]) -> str:
    if scope.get("topicId"):
        return scope["topicId"]
    topics = sorted(services.store.list("topic", sid), key=lambda t: (t.get("order") or 0, t.get("title") or ""))
    for t in topics:
        if (t.get("title") or "").strip().lower() == "cuaderno":
            return t["id"]
    if topics:
        return topics[0]["id"]
    now = services.now_iso()
    topic = {"id": str(uuid.uuid4()), "subjectId": sid, "title": "Cuaderno", "order": 1,
             "createdAt": now, "updatedAt": now}
    services.store.put("topic", topic)
    return topic["id"]


def to_questions(services: Any, item_id: str) -> dict[str, Any]:
    """FAQ → DESARROLLO questions (origin 'alumno', tag 'cuaderno'), deduplicated by contentHash."""
    r = _item_row(services, item_id)
    if r["kind"] != "faq":
        raise ValueError("Solo unas preguntas frecuentes se pueden convertir en preguntas")
    scope = _loads(r.get("scope"), {})
    sid = r["subject_id"]
    topic_id = _topic_for_questions(services, sid, scope)
    added, skipped = [], 0
    for it in _loads(r["data"], []):
        prompt = str(it.get("q") or "").strip()
        answer = retrieval.strip_markers(str(it.get("a") or ""))
        if not prompt or not answer:
            continue
        now = services.now_iso()
        q = {"id": str(uuid.uuid4()), "subjectId": sid, "topicId": topic_id, "type": "DESARROLLO",
             "prompt": prompt, "modelAnswer": answer, "origin": "alumno", "tags": ["cuaderno"],
             "stats": {"seen": 0, "correct": 0, "wrong": 0}, "createdAt": now, "updatedAt": now}
        src = _source_line(it.get("citations") or [])
        if src:
            q["explanation"] = src
        q["contentHash"] = compute_content_hash(q)
        if services.store.by_hash("question", q["contentHash"]):
            skipped += 1
            continue
        services.store.put("question", q)
        added.append(q["id"])
    return {"added": len(added), "skipped": skipped, "ids": added, "topicId": topic_id}


def add_as_source(services: Any, item_id: str) -> dict[str, Any]:
    """Save a finished item's markdown as a 'studio' source of its subject and index it."""
    r = row(services, "SELECT * FROM studio_items WHERE id=?", (item_id,))
    if not r or r["status"] != "done" or not r.get("content"):
        raise ValueError("El elemento aún no está terminado")
    from . import sources

    target = sources.uploads_dir(services, r["subject_id"]) / f"estudio-{item_id}.md"
    target.write_text(r["content"], encoding="utf-8")
    src, _change = sources.register_file(services, r["subject_id"], target, "studio", r.get("title"))
    return sources.public_source(sources.index_source(services, src["id"]))
