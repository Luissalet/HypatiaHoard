from __future__ import annotations

import io
import wave

import pytest

from hypatia.notebook import mindmap, podcast, studio, worker

from nbfakes import tiny_wav


def _run(svc, kind, **kw):
    res = studio.create(svc, "sub1", kind, **kw)
    item = res["item"]
    assert item["status"] in ("queued", "running", "done", "error")
    done = studio.wait(svc, item["id"], 20)
    assert done["status"] in ("done", "error"), done
    return done


@pytest.mark.parametrize("kind", ["study_guide", "briefing", "timeline"])
def test_markdown_kinds(indexed, kind):
    item = _run(indexed, kind)
    assert item["status"] == "done" and item["model"] == "fake-llm"
    assert "[500]" not in item["content"]
    assert item["citations"] and all(c["filename"] for c in item["citations"])
    ns = {c["n"] for c in item["citations"]}
    assert ns <= {1, 2}
    if kind == "study_guide":
        assert item["title"] == "Guía de redes"


def test_faq_and_to_questions(indexed):
    item = _run(indexed, "faq")
    assert item["status"] == "done"
    assert [d["q"] for d in item["data"]] == ["¿Qué es un perceptrón?", "¿Cómo se entrena?"]
    assert item["data"][1]["a"].endswith("[2].") and "[77]" not in item["content"]
    assert item["title"] == "FAQ redes"
    res = studio.to_questions(indexed, item["id"])
    assert res["added"] == 2 and res["skipped"] == 0
    qs = indexed.store.list("question", "sub1")
    q = next(q for q in qs if q["prompt"] == "¿Qué es un perceptrón?")
    assert q["type"] == "DESARROLLO" and q["origin"] == "alumno" and q["tags"] == ["cuaderno"]
    assert q["modelAnswer"] == "La unidad básica de una red." and q["contentHash"].startswith("sha256:")
    assert q["topicId"] == "t1" and q["stats"]["seen"] == 0
    assert studio.to_questions(indexed, item["id"])["skipped"] == 2  # idempotent
    with pytest.raises(ValueError):
        studio.to_concepts(indexed, item["id"])


def test_glossary_and_to_concepts(indexed):
    item = _run(indexed, "glossary", topic="tema 1")
    assert [d["term"] for d in item["data"]] == ["Perceptrón", "Gradiente"]
    assert item["data"][0]["citations"][0]["n"] == 1
    res = studio.to_concepts(indexed, item["id"])
    assert res["added"] == 2
    kc = indexed.store.list("keyConcept", "sub1")
    assert {c["category"] for c in kc} == {"definition"} and all(c["topicId"] == "t1" for c in kc)
    assert all("[1]" not in c["content"] and c["contentHash"] for c in kc)
    assert studio.to_concepts(indexed, item["id"])["added"] == 0


def test_mindmap_is_trimmed(indexed):
    item = _run(indexed, "mindmap")
    tree = item["data"]
    assert mindmap.count_nodes(tree) <= 60 and mindmap.depth(tree) <= 4
    assert len(tree["label"]) <= 80
    assert all(n in (1, 2) for n in mindmap.all_refs(tree))
    assert item["content"].startswith("# ")


def test_mindmap_validate_edge_cases():
    assert mindmap.validate("nope", fallback_label="X") == {"label": "X", "children": []}
    t = mindmap.validate([{"label": "a"}, "b", 3], fallback_label="Raíz")
    assert t["label"] == "Raíz" and [c["label"] for c in t["children"]] == ["a", "b"]


def test_podcast_with_tts(indexed, fake):
    (indexed.config.data_dir / "backend.json").write_text('{"podcast": {"voices": ["vozA", "vozB"]}}')
    item = _run(indexed, "podcast")
    assert item["status"] == "done", item
    script = item["data"]
    assert [t["speaker"] for t in script["turns"]] == ["A", "B", "A", "B"]  # consecutive B merged
    texts = " ".join(t["text"] for t in script["turns"])
    for bad in ("(música)", "*ríe*", "[risas]", "Ana:", "[1]"):
        assert bad not in texts
    assert item["audioUrl"] == f"/api/notebook/studio/{item['id']}/audio"
    path = studio.audio_path(indexed, item["id"])
    assert path and path.name == f"{item['id']}.wav"
    with wave.open(str(path)) as w:
        frames = w.getnframes()
        rate = w.getframerate()
    speech = sum(len(t) * 5 for t, _v in fake.tts_calls)
    assert frames == speech + 3 * int(rate * 0.3)  # 300 ms between the 4 turns
    assert {v for _t, v in fake.tts_calls} == {"vozA", "vozB"}
    assert studio.delete_item(indexed, item["id"]) and not path.exists()


def test_podcast_without_tts_keeps_script(indexed, fake):
    fake.caps["tts"] = False
    item = _run(indexed, "podcast")
    assert item["status"] == "done" and item["data"]["turns"] and item["audioUrl"] is None
    assert "tts" in item["note"]


def test_podcast_format_mismatch_is_clear_error(indexed, fake):
    (indexed.config.data_dir / "backend.json").write_text('{"podcast": {"voices": ["vozA", "vozB"]}}')
    fake.tts_mismatch = True
    item = _run(indexed, "podcast")
    assert item["status"] == "error" and "formatos distintos" in item["error"]
    assert item["data"]["turns"]  # script kept


def test_concat_and_split_helpers():
    out = podcast.concat_wavs([(tiny_wav(100), True), (tiny_wav(50), False), (tiny_wav(10), True)], silence_ms=100)
    with wave.open(io.BytesIO(out)) as w:
        assert w.getnframes() == 160 + 1600
    with pytest.raises(podcast.AudioFormatError):
        podcast.concat_wavs([(b"not a wav", True)])
    parts = podcast.split_for_tts("Frase uno. " * 100, limit=100)
    assert all(len(p) <= 100 for p in parts) and len(parts) > 5


def test_map_reduce_for_big_material(indexed, fake, monkeypatch):
    monkeypatch.setattr(studio, "DIRECT_CHARS", 300)
    monkeypatch.setattr(studio, "GROUP_CHARS", 500)
    monkeypatch.setattr(studio, "REDUCE_CHARS", 60)
    item = _run(indexed, "study_guide")
    assert item["status"] == "done"
    systems = [c["system"] for c in fake.calls]
    assert sum("Extraes notas" in s for s in systems) >= 2
    assert any("Condensas notas" in s for s in systems)
    final_user = fake.calls[-1]["user"]
    assert final_user.startswith("Notas extraídas")


def test_without_model_returns_material(indexed, fake):
    fake.caps["llm"] = False
    res = studio.create(indexed, "sub1", "study_guide")
    assert res["item"] is None and res["material"].startswith("[1]") and res["note"]
    assert res["citations"][0]["n"] == 1
    assert studio.list_items(indexed, "sub1") == []


def test_without_sources(svc):
    res = studio.create(svc, "sub1", "faq")
    assert res["item"] is None and "fuentes" in res["note"]


def test_bad_kind(indexed):
    with pytest.raises(ValueError):
        studio.create(indexed, "sub1", "poema")


def test_job_error_is_recorded(indexed, fake):
    fake.overrides["PREGUNTAS FRECUENTES"] = "no es json en absoluto"
    item = _run(indexed, "faq")
    assert item["status"] == "error" and "JSON" in item["error"]


def test_add_as_source(indexed):
    item = _run(indexed, "briefing", add_as_source=True)
    worker.get_worker(indexed).wait_idle(10)
    from hypatia.notebook import sources

    srcs = [s for s in sources.list_sources(indexed, "sub1") if s["origin"] == "studio"]
    assert len(srcs) == 1 and srcs[0]["status"] == "indexed" and srcs[0]["title"] == item["title"]


def test_list_and_worker_restart_requeues(indexed, fake):
    fake.caps["llm"] = True
    first = _run(indexed, "briefing")
    assert studio.list_items(indexed, "sub1")[0]["id"] == first["id"]
    assert "content" not in studio.list_items(indexed, "sub1")[0]
    # simulate a crash mid-job: a 'running' row is requeued by start_worker
    worker.stop_worker()
    with indexed.db.tx() as conn:
        conn.execute("UPDATE studio_items SET status='running' WHERE id=?", (first["id"],))
    worker.start_worker(indexed, initial_scan=False)
    assert studio.wait(indexed, first["id"], 10)["status"] == "done"


def test_stop_worker_is_clean(indexed):
    w = worker.start_worker(indexed, initial_scan=True)
    worker.stop_worker()
    assert not w.thread.is_alive()
