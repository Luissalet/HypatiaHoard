"""Test helpers: stub Services (no dependency on the core server modules), fake Hoard Link, fixture files."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import re
import sqlite3
import threading
import wave
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from hypatia.hashing import slugify
from hypatia.notebook import init_schema


# ---------------------------------------------------------------- fake link

class Unavailable(Exception):
    pass


try:
    from hypatia.hoard_link import Unavailable as _RealUnavailable  # noqa: F811

    def _unavailable(cap: str) -> Exception:
        return _RealUnavailable(cap, ["fake: disabled"])
except Exception:  # pragma: no cover
    def _unavailable(cap: str) -> Exception:
        return Unavailable(cap)


@dataclass
class FakeResolution:
    capability: str
    resolved: bool
    model: Optional[str]
    reason: str


@dataclass
class FakeChatResult:
    text: str
    model: Optional[str] = "fake-llm"


def fake_vector(text: str, dim: int = 64) -> list[float]:
    v = [0.0] * dim
    for tok in re.findall(r"\w+", text.lower()):
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        v[h % dim] += 1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def tiny_wav(n_samples: int = 800, rate: int = 16000, channels: int = 1) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x01\x00" * n_samples * channels)
    return buf.getvalue()


PODCAST_JSON = {
    "title": "Charla sobre redes",
    "turns": [
        {"speaker": "A", "text": "(música) Ana: Hola, hoy hablamos de redes neuronales [1]."},
        {"speaker": "B", "text": "*ríe* Sí, el perceptrón es la unidad básica."},
        {"speaker": "B", "text": "Y se entrena con descenso de gradiente."},
        {"speaker": "A", "text": "[risas] ¿Y la retropropagación?"},
        {"speaker": "B", "text": "Calcula los gradientes capa a capa."},
    ],
}


def deep_tree(depth: int, breadth: int, prefix: str = "n") -> dict:
    node: dict[str, Any] = {"label": f"{prefix} " + "x" * 100 if depth == 6 else prefix, "refs": [1, 999]}
    if depth > 0:
        node["children"] = [deep_tree(depth - 1, breadth, f"{prefix}.{i}") for i in range(breadth)]
    return node


class FakeLink:
    """Async context manager with chat/embed/tts/resolve; canned answers by prompt kind."""

    def __init__(self, state: "FakeState"):
        self.state = state

    async def __aenter__(self) -> "FakeLink":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def resolve(self, cap: str) -> FakeResolution:
        ok = self.state.caps.get(cap, False)
        return FakeResolution(cap, ok, f"fake-{cap}" if ok else None, "fake")

    async def chat(self, messages, max_tokens=None, temperature=None, response_format=None, **kw) -> FakeChatResult:
        if not self.state.caps.get("llm"):
            raise _unavailable("llm")
        system = messages[0]["content"] if messages and messages[0]["role"] == "system" else ""
        user = messages[-1]["content"]
        self.state.calls.append({"system": system, "user": user, "response_format": response_format,
                                 "n_messages": len(messages)})
        return FakeChatResult(self.state.answer(system, user))

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not self.state.caps.get("embeddings"):
            raise _unavailable("embeddings")
        self.state.embed_calls += 1
        return [fake_vector(t) for t in texts]

    async def tts(self, text: str, voice: Optional[str] = None) -> bytes:
        if not self.state.caps.get("tts"):
            raise _unavailable("tts")
        self.state.tts_calls.append((text, voice))
        if self.state.tts_mismatch and voice == "vozB":
            return tiny_wav(len(text) * 5, rate=22050)
        return tiny_wav(len(text) * 5)


class FakeState:
    def __init__(self) -> None:
        self.caps = {"llm": True, "embeddings": False, "tts": True}
        self.calls: list[dict[str, Any]] = []
        self.embed_calls = 0
        self.tts_calls: list[tuple[str, Optional[str]]] = []
        self.tts_mismatch = False
        self.tutor_assessments: list[str] = []
        self.mindmap: Any = None
        self.overrides: dict[str, str] = {}

    def answer(self, system: str, user: str) -> str:
        for key, text in self.overrides.items():
            if key in system:
                return text
        if "Respondes SOLO" in system:
            return "El perceptrón es la unidad básica [1]. Se entrena con gradiente [2, 99]. Inventado [42]."
        if "Extraes notas" in system:
            nums = re.findall(r"^\[(\d+)\]", user, re.M)
            return "\n".join(f"- nota del pasaje [{n}]" for n in nums[:3]) or "- nada"
        if "Condensas notas" in system:
            nums = re.findall(r"\[(\d+)\]", user)
            return "\n".join(f"- condensado [{n}]" for n in nums[:3])
        if "GUÍA DE ESTUDIO" in system:
            return "# Guía de redes\n\n## Resumen\n\nLas redes aprenden [1]. Dato falso [500].\n"
        if "DOCUMENTO INFORMATIVO" in system or "CRONOLOGÍA" in system:
            return "# Documento\n\nContenido [1][2]."
        if "PREGUNTAS FRECUENTES" in system:
            return "```json\n" + json.dumps({"title": "FAQ redes", "items": [
                {"q": "¿Qué es un perceptrón?", "a": "La unidad básica de una red [1]."},
                {"q": "¿Cómo se entrena?", "a": "Con descenso de gradiente [2][77]."},
                {"q": "", "a": "vacía"},
            ]}, ensure_ascii=False) + "\n```"
        if "GLOSARIO" in system:
            return "Aquí tienes: " + json.dumps({"items": [
                {"term": "Perceptrón", "definition": "Unidad básica [1]."},
                {"term": "Gradiente", "definition": "Dirección de máximo crecimiento [2]."},
            ]}, ensure_ascii=False) + " ¡Suerte!"
        if "MAPA MENTAL" in system:
            return json.dumps(self.mindmap if self.mindmap is not None else deep_tree(6, 3, "Redes"))
        if "guiones de pódcast" in system:
            return json.dumps(PODCAST_JSON, ensure_ascii=False)
        if "tutor socrático" in system:
            a = self.tutor_assessments.pop(0) if self.tutor_assessments else "none"
            return json.dumps({"reply": f"¿Qué hace el perceptrón? [1] [88] ({a})", "assessment": a,
                               "point": "perceptrón", "explained": False}, ensure_ascii=False)
        if "ha fallado" in system:
            return "El perceptrón combina entradas ponderadas [1]. ¿Qué función aplica después?"
        return "respuesta genérica"


# ---------------------------------------------------------------- stub services

class StubDB:
    def __init__(self, path: Path):
        self.lock = threading.RLock()
        self._depth = 0
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row

    @contextmanager
    def tx(self):
        with self.lock:
            if self._depth:
                self._depth += 1
                try:
                    yield self.conn
                finally:
                    self._depth -= 1
                return
            self.conn.execute("BEGIN IMMEDIATE")
            self._depth = 1
            try:
                yield self.conn
            except BaseException:
                self._depth = 0
                self.conn.execute("ROLLBACK")
                raise
            self._depth = 0
            self.conn.execute("COMMIT")


class StubStore:
    def __init__(self) -> None:
        self.data: dict[tuple[str, str], dict] = {}
        self.rev = 0

    def get(self, kind: str, id: str) -> Optional[dict]:
        return self.data.get((kind, id))

    def put(self, kind: str, obj: dict) -> int:
        self.rev += 1
        self.data[(kind, obj["id"])] = json.loads(json.dumps(obj))
        return self.rev

    def list(self, kind: str, subject_id: Optional[str] = None) -> list[dict]:
        out = [v for (k, _), v in self.data.items() if k == kind]
        if subject_id is not None:
            out = [v for v in out if v.get("subjectId") == subject_id]
        return out

    def by_hash(self, kind: str, h: str) -> list[dict]:
        return [v for (k, _), v in self.data.items() if k == kind and v.get("contentHash") == h]


@dataclass
class StubConfig:
    data_dir: Path
    resources_dir: Path


class StubServices:
    def __init__(self, tmp: Path, state: FakeState):
        self.config = StubConfig(tmp / "data", tmp / "resources")
        self.config.data_dir.mkdir(parents=True, exist_ok=True)
        self.config.resources_dir.mkdir(parents=True, exist_ok=True)
        self.db = StubDB(self.config.data_dir / "test.db")
        with self.db.lock:
            init_schema(self.db.conn)
        self.store = StubStore()
        self.fake = state
        self._t = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
        self._tl = threading.Lock()

    def now(self) -> datetime:
        with self._tl:
            self._t += timedelta(milliseconds=1)
            return self._t

    def now_iso(self) -> str:
        m = self.now()
        return m.strftime("%Y-%m-%dT%H:%M:%S.") + f"{m.microsecond // 1000:03d}Z"

    def link(self) -> FakeLink:
        return FakeLink(self.fake)

    def run_async(self, coro):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(coro)
        box: dict[str, Any] = {}

        def runner() -> None:
            try:
                box["v"] = asyncio.run(coro)
            except BaseException as e:  # noqa: BLE001
                box["e"] = e

        t = threading.Thread(target=runner)
        t.start()
        t.join()
        if "e" in box:
            raise box["e"]
        return box.get("v")

    def resolve_subject(self, ref: str) -> dict:
        for s in self.store.list("subject"):
            if ref in (s["id"], s["name"]) or slugify(ref) == slugify(s["name"]):
                return s
        raise LookupError(f"No subject {ref}")

    def resolve_topic(self, subject_id: str, ref: str) -> dict:
        topics = sorted(self.store.list("topic", subject_id), key=lambda t: t.get("order") or 0)
        for t in topics:
            if ref == t["id"] or slugify(ref) == slugify(t["title"]):
                return t
        m = re.match(r"^(?:tema\s*)?(\d+)$", ref.strip(), re.I)
        if m and 1 <= int(m.group(1)) <= len(topics):
            return topics[int(m.group(1)) - 1]
        raise LookupError(f"No topic {ref}")


# ---------------------------------------------------------------- fixture files

PAGE_TEXTS = [
    "El perceptrón es la unidad básica de una red neuronal. Combina entradas ponderadas y aplica una función de activación escalón.",
    "El descenso de gradiente ajusta los pesos minimizando la función de pérdida. La retropropagación calcula los gradientes capa a capa.",
    "Las redes convolucionales usan filtros compartidos para procesar imágenes. El pooling reduce la resolución espacial.",
]


def make_pdf(path: Path, pages: list[str], header: str = "Universidad Internacional — Redes Neuronales") -> Path:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=A4)
    for i, text in enumerate(pages, start=1):
        c.setFont("Helvetica", 10)
        c.drawString(50, 800, header)
        y = 760
        words = text.split()
        line = ""
        for w in words:
            if len(line) + len(w) > 80:
                c.drawString(50, y, line)
                y -= 14
                line = ""
            line = (line + " " + w).strip()
        if line:
            c.drawString(50, y, line)
        c.drawString(50, 30, f"Página {i} de {len(pages)}")
        c.showPage()
    c.save()
    return path


def make_docx(path: Path, blocks: list[tuple[str, str]]) -> Path:
    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    paras = []
    for style, text in blocks:
        ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        paras.append(f"<w:p>{ppr}<w:r><w:t>{text}</w:t></w:r></w:p>")
    xml = f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{ns}"><w:body>{"".join(paras)}</w:body></w:document>'
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("word/document.xml", xml)
    return path


