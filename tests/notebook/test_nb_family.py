"""The notebook on the family's shared services: Borges's embeddings, Kafka's OCR, and the index version."""
from __future__ import annotations

import pytest
from nbfakes import PAGE_TEXTS, fake_vector

from hypatia.hoard_link import family
from hypatia.hoard_link.docs import vecmath
from hypatia.notebook import llm, retrieval, sources
from hypatia.notebook.schema import rows


class FakeHub:
    """Stands in for ``family.call``: Borges's ``embed_*`` tools and Kafka's ``doc_extract``."""

    def __init__(self, model="borges-model", dim=64):
        self.model, self.dim = model, dim
        self.calls: list[tuple[str, str, dict]] = []
        self.ocr_units = [{"kind": "page", "number": 1, "title": "", "text": "Texto reconocido por el OCR de la primera página."},
                          {"kind": "page", "number": 2, "title": "", "text": "Segunda página leída por reconocimiento óptico."}]
        self.down: set[str] = set()   # owners that do not answer
        self.fail: dict[str, str] = {}  # tool -> error text

    def __call__(self, app, tool, arguments=None, **kwargs):
        args = dict(arguments or {})
        self.calls.append((app, tool, args))
        if app in self.down:
            return {"ok": False, "app": app, "tool": tool, "status": None, "error": f"{app} unreachable", "contract": 1}
        if tool in self.fail:
            return {"ok": False, "app": app, "tool": tool, "status": 400, "error": self.fail[tool], "contract": 1}
        if tool == "embed_status":
            return {"ok": True, "status": 200, "contract": 1, "result": {"backend": "fake", "model": self.model, "dim": self.dim,
                                                                         "state": "ready", "ready": True}}
        if tool == "embed_texts":
            vecs = [fake_vector(t, self.dim) for t in args["texts"]]
            return {"ok": True, "status": 200, "contract": 1,
                    "result": {"model": self.model, "dim": self.dim, "vectors": vecs, "normalized": True}}
        if tool == "doc_extract":
            return {"ok": True, "status": 200, "contract": 1,
                    "result": {"kind": "pdf", "title": "", "text": "", "units": self.ocr_units, "needs_ocr": False,
                               "notes": [], "pages_ocr": len(self.ocr_units), "status": "done"}}
        raise AssertionError(f"unexpected tool {tool}")


@pytest.fixture
def hub(monkeypatch):
    h = FakeHub()
    monkeypatch.setattr(family, "call", h)
    return h


# ---------------------------------------------------------------- embeddings

def test_embeddings_come_from_borges_and_the_model_is_recorded(svc, resources, fake, hub):
    fake.caps["embeddings"] = False  # Hypatia's own Link has none: only Borges can embed
    counts = sources.scan_subject(svc, svc.store.get("subject", "sub1"))
    for sid in counts["pending"]:
        sources.index_source(svc, sid)
    found = rows(svc, "SELECT COUNT(*) AS n, MIN(dim) AS d, MAX(model) AS m FROM chunk_vecs")[0]
    assert found["n"] == rows(svc, "SELECT COUNT(*) AS n FROM chunks")[0]["n"] and found["d"] == 64
    assert found["m"] == "borges-model" and fake.embed_calls == 0
    assert {c[2]["kind"] for c in hub.calls if c[1] == "embed_texts"} == {"document"}
    res = retrieval.search(svc, "sub1", "filtros compartidos para imágenes convolucionales")
    assert res["reranked"] is True
    assert any(c[1] == "embed_texts" and c[2]["kind"] == "query" for c in hub.calls)


def test_own_link_embeds_only_when_borges_is_not_there(svc, fake, hub):
    fake.caps["embeddings"] = True
    hub.down.add("borges")
    model, vecs = llm.embed(svc, [["uno", "dos"], ["tres"]])
    assert model == "fake-embeddings" and [len(b) for b in vecs] == [2, 1]
    hub.down.clear()
    model, vecs = llm.embed(svc, [["uno"]])
    assert model == "borges-model" and fake.embed_calls == 2  # the two batches of the earlier call only


def test_a_failing_borges_is_not_papered_over_by_another_model(svc, fake, hub):
    fake.caps["embeddings"] = True
    hub.fail["embed_texts"] = "embedder_loading"
    with pytest.raises(llm.NoModel):
        llm.embed(svc, [["uno"]])
    assert fake.embed_calls == 0


def test_a_change_of_model_re_embeds_the_old_vectors(indexed, fake, hub):
    fake.caps["embeddings"] = True
    hub.down.add("borges")
    sources._no_embed_until.clear()  # indexing found no model a moment ago
    for s in sources.list_sources(indexed, "sub1"):
        sources.embed_source(indexed, s["id"])
    assert {r["model"] for r in rows(indexed, "SELECT DISTINCT model FROM chunk_vecs")} == {"fake-embeddings"}
    assert sources.sources_missing_vectors(indexed, "sub1", "fake-embeddings") == []
    hub.down.clear()  # Borges comes back with another model
    stale = sources.sources_missing_vectors(indexed, "sub1", "borges-model")
    assert len(stale) == 2
    sources._no_embed_until.clear()
    for sid in stale:
        assert sources.embed_source(indexed, sid) > 0
    assert {r["model"] for r in rows(indexed, "SELECT DISTINCT model FROM chunk_vecs")} == {"borges-model"}
    assert sources.sources_missing_vectors(indexed, "sub1", "borges-model") == []


def test_vector_search_scans_every_vector_in_blocks(indexed, monkeypatch):
    """The old scan stopped at 6000 vectors; now every stored vector is scored, a block at a time."""
    ids = [r["id"] for r in rows(indexed, "SELECT id FROM chunks ORDER BY id")]
    target = fake_vector("zebras rayadas en la sabana africana")
    with indexed.db.tx() as conn:
        for i, cid in enumerate(ids):  # every chunk gets an unrelated vector...
            conn.execute("INSERT OR REPLACE INTO chunk_vecs(chunk_id, model, dim, vec) VALUES(?,?,?,?)",
                         (cid, "m", 64, vecmath.pack_vec(fake_vector(f"ruido {i}"))))
        last = ids[-1]  # ...except the last one, the match
        conn.execute("UPDATE chunk_vecs SET vec=? WHERE chunk_id=?", (vecmath.pack_vec(target), last))
    monkeypatch.setattr(retrieval, "VECTOR_BLOCK", 2)  # the match sits in the last of many blocks
    monkeypatch.setattr(llm, "embed", lambda services, batches, kind="document": ("m", [[target]]))
    scope = retrieval.resolve_scope(indexed, "sub1")["sourceIds"]
    scores = retrieval._vectors(indexed, "zebras", scope, set())
    assert max(scores, key=scores.get) == last and scores[last] == pytest.approx(1.0, abs=1e-5)
    assert len(scores) <= retrieval.FTS_CANDIDATES


# ---------------------------------------------------------------- scanned PDFs

def _blank_pdf(path, pages=2):
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path))
    for _ in range(pages):
        c.showPage()
    c.save()
    return path


def test_a_scanned_pdf_is_read_by_the_ocr_through_the_hub(svc, tmp_path, hub):
    pdf = _blank_pdf(tmp_path / "escaneado.pdf")
    pages, chunks = sources.extract_chunks(pdf, "pdf")
    assert pages == 2 and [c["page"] for c in chunks] == [1, 2]
    assert "OCR de la primera" in chunks[0]["text"]
    assert [c[2]["ocr"] for c in hub.calls if c[1] == "doc_extract"] == ["auto"]


def test_a_text_pdf_never_asks_for_ocr(svc, tmp_path, hub):
    from nbfakes import make_pdf

    sources.extract_chunks(make_pdf(tmp_path / "texto.pdf", PAGE_TEXTS), "pdf")
    assert not [c for c in hub.calls if c[1] == "doc_extract"]


def test_a_scan_without_kafka_says_there_is_no_text(svc, tmp_path, hub):
    hub.down.add("kafka")
    src, _ = sources.save_upload(svc, "sub1", "escaneado.pdf", _blank_pdf(tmp_path / "e.pdf").read_bytes())
    out = sources.index_source(svc, src["id"])
    assert out["status"] == "error" and "OCR" in out["error"]


def test_an_ocr_that_fails_is_reported_not_swallowed(svc, tmp_path, hub):
    hub.fail["doc_extract"] = "ocr engine crashed"
    with pytest.raises(sources.SourceError) as info:
        sources.extract_chunks(_blank_pdf(tmp_path / "x.pdf"), "pdf")
    assert "ocr engine crashed" in str(info.value)


# ---------------------------------------------------------------- index version

def test_a_source_indexed_under_old_rules_is_rebuilt_by_the_next_rescan(indexed):
    subject = indexed.store.get("subject", "sub1")
    assert sources.scan_subject(indexed, subject)["pending"] == []
    assert {r["index_version"] for r in rows(indexed, "SELECT index_version FROM sources")} == {sources.INDEX_VERSION}
    with indexed.db.tx() as conn:
        conn.execute("UPDATE sources SET index_version=NULL")  # what a database from before the shared chunker has
        conn.execute("UPDATE chunks SET text='viejo ' || text")
    pending = sources.scan_subject(indexed, subject)["pending"]
    assert len(pending) == 2
    assert all(s["status"] == "indexed" for s in sources.list_sources(indexed, "sub1"))  # searchable meanwhile
    for sid in pending:
        sources.index_source(indexed, sid)
    assert not any(r["text"].startswith("viejo ") for r in rows(indexed, "SELECT text FROM chunks"))
    assert sources.scan_subject(indexed, subject)["pending"] == []


# ---------------------------------------------------------------- waiting

def test_waiting_for_a_job_that_is_not_done_says_it_is_still_running(svc):
    from hypatia.notebook import studio

    with svc.db.tx() as conn:
        conn.execute("INSERT INTO studio_items(id, subject_id, kind, status) VALUES('it1', 'sub1', 'guide', 'running')")
    item = studio.wait(svc, "it1", 0)
    assert item["status"] == "running" and item["still_running"] is True and "waited_s" in item
    with svc.db.tx() as conn:
        conn.execute("UPDATE studio_items SET status='done' WHERE id='it1'")
    done = studio.wait(svc, "it1", 150)
    assert done["status"] == "done" and "still_running" not in done
    assert studio.wait(svc, "nope", 1) is None


def test_the_tools_wait_up_to_the_family_limit_and_no_more():
    from pydantic import ValidationError

    from hypatia.notebook.tools import StudioGenerateArgs

    assert StudioGenerateArgs(subject="x", kind="study_guide", wait_s=150).wait_s == 150
    with pytest.raises(ValidationError):
        StudioGenerateArgs(subject="x", kind="study_guide", wait_s=151)
