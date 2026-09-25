"""Fixtures for the notebook tests (helpers live in nbfakes.py)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hypatia.hashing import slugify
from hypatia.notebook import worker as nb_worker
from nbfakes import PAGE_TEXTS, FakeState, StubServices, make_pdf


# ---------------------------------------------------------------- fixtures

@pytest.fixture
def fake() -> FakeState:
    return FakeState()


@pytest.fixture
def svc(tmp_path: Path, fake: FakeState):
    s = StubServices(tmp_path, fake)
    s.store.put("subject", {"id": "sub1", "name": "Redes Neuronales y Aprendizaje Profundo",
                            "createdAt": "x", "updatedAt": "x"})
    s.store.put("topic", {"id": "t1", "subjectId": "sub1", "title": "Tema 1- Perceptrón", "order": 1,
                          "pdfFilename": "Tema 1- Perceptrón.pdf", "createdAt": "x", "updatedAt": "x"})
    s.store.put("topic", {"id": "t2", "subjectId": "sub1", "title": "Tema 2- Convolucionales", "order": 2,
                          "createdAt": "x", "updatedAt": "x"})
    yield s
    nb_worker.stop_worker()
    s.db.conn.close()


@pytest.fixture
def resources(svc: StubServices) -> Path:
    """resources/<slug>/Temas/Tema 1- Perceptrón.pdf (+ index.json) and Resumenes/resumen.md."""
    root = svc.config.resources_dir / slugify("Redes Neuronales y Aprendizaje Profundo")
    make_pdf(root / "Temas" / "Tema 1- Perceptrón.pdf", PAGE_TEXTS)
    (root / "Temas" / "index.json").write_text(json.dumps(
        [{"topicTitle": "Tema 1- Perceptrón", "pdf": "Tema 1- Perceptrón.pdf"}], ensure_ascii=False), encoding="utf-8")
    (root / "Resumenes").mkdir(parents=True, exist_ok=True)
    (root / "Resumenes" / "resumen.md").write_text(
        "# Convolucionales\n\nLas capas convolucionales detectan bordes y texturas en imágenes.\n\n"
        "# Recurrentes\n\nLas redes recurrentes procesan secuencias como texto.\n", encoding="utf-8")
    return root


@pytest.fixture
def indexed(svc: StubServices, resources: Path) -> StubServices:
    from hypatia.notebook import sources

    counts = sources.scan_subject(svc, svc.store.get("subject", "sub1"))
    for sid in counts["pending"]:
        sources.index_source(svc, sid)
    return svc
