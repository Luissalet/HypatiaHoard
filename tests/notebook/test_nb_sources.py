from __future__ import annotations

from hypatia.notebook import sources
from hypatia.notebook.schema import rows

from nbfakes import PAGE_TEXTS, make_docx, make_pdf


def _by_name(svc):
    return {s["filename"]: s for s in sources.list_sources(svc, "sub1")}


def test_scan_and_index_pdf_and_md(indexed):
    listed = _by_name(indexed)
    pdf = listed["Tema 1- Perceptrón.pdf"]
    assert pdf["status"] == "indexed" and pdf["pages"] == 3 and pdf["origin"] == "repo"
    assert pdf["title"] == "Tema 1- Perceptrón"  # from index.json
    assert listed["resumen.md"]["status"] == "indexed"
    assert "index.json" not in listed
    chunks = rows(indexed, "SELECT page, text FROM chunks WHERE source_id=? ORDER BY ord", (pdf["id"],))
    assert [c["page"] for c in chunks] == [1, 2, 3]
    joined = " ".join(c["text"] for c in chunks)
    assert "perceptrón" in joined.lower()
    # header (same on every page) and "Página N de 3" footer are stripped
    assert "Universidad Internacional" not in joined
    assert "Página" not in joined
    md_chunks = rows(indexed, "SELECT heading FROM chunks WHERE source_id=?", (listed["resumen.md"]["id"],))
    assert {c["heading"] for c in md_chunks} == {"Convolucionales", "Recurrentes"}


def test_rescan_is_idempotent_and_detects_changes(indexed, resources):
    subject = indexed.store.get("subject", "sub1")
    counts = sources.scan_subject(indexed, subject)
    assert counts["unchanged"] == 2 and counts["pending"] == []
    make_pdf(resources / "Temas" / "Tema 1- Perceptrón.pdf", PAGE_TEXTS + ["Una cuarta página nueva."])
    counts = sources.scan_subject(indexed, subject)
    assert counts["changed"] == 1 and len(counts["pending"]) == 1
    src = sources.index_source(indexed, counts["pending"][0])
    assert src["pages"] == 4
    # a duplicate copy of the same file under another name is not registered twice
    (resources / "Temas" / "copia.md").write_bytes((resources / "Resumenes" / "resumen.md").read_bytes())
    counts = sources.scan_subject(indexed, subject)
    assert counts["duplicate"] == 1


def test_delete_repo_source_is_remembered(indexed):
    pdf = _by_name(indexed)["Tema 1- Perceptrón.pdf"]
    assert sources.delete_source(indexed, pdf["id"])
    assert rows(indexed, "SELECT * FROM chunks WHERE source_id=?", (pdf["id"],)) == []
    sources.scan_subject(indexed, indexed.store.get("subject", "sub1"))
    assert "Tema 1- Perceptrón.pdf" not in _by_name(indexed)


def test_vanished_repo_file_is_forgotten(indexed, resources):
    (resources / "Resumenes" / "resumen.md").unlink()
    counts = sources.scan_subject(indexed, indexed.store.get("subject", "sub1"))
    assert counts["removed"] == 1
    assert "resumen.md" not in _by_name(indexed)


def test_upload_txt_docx_and_delete(svc, tmp_path):
    src, change = sources.save_upload(svc, "sub1", "../../apuntes.txt", "Texto plano sobre dropout y regularización.".encode())
    assert change == "new" and src["origin"] == "upload"
    stored = svc.config.data_dir / "sources" / "sub1" / "apuntes.txt"
    assert stored.is_file()
    sources.index_source(svc, src["id"])
    docx = make_docx(tmp_path / "notas.docx", [("Heading1", "Regularización"), ("", "El dropout apaga neuronas al azar."),
                                               ("", "La norma L2 penaliza pesos grandes.")])
    d, _ = sources.save_upload(svc, "sub1", "notas.docx", docx.read_bytes())
    out = sources.index_source(svc, d["id"])
    assert out["status"] == "indexed"
    ch = rows(svc, "SELECT heading, text FROM chunks WHERE source_id=?", (d["id"],))
    assert ch[0]["heading"] == "Regularización" and "dropout" in ch[0]["text"]
    assert sources.delete_source(svc, src["id"])
    assert not stored.exists()


def test_upload_rejects_bad_type_and_empty(svc):
    import pytest

    with pytest.raises(sources.SourceError):
        sources.save_upload(svc, "sub1", "virus.exe", b"MZ")
    with pytest.raises(sources.SourceError):
        sources.save_upload(svc, "sub1", "vacio.md", b"")


def test_broken_pdf_is_error_not_crash(svc):
    src, _ = sources.save_upload(svc, "sub1", "roto.pdf", b"%PDF-1.4 esto no es un pdf")
    out = sources.index_source(svc, src["id"])
    assert out["status"] == "error" and out["error"]


def test_add_paths_folder_in_place(svc, tmp_path):
    folder = tmp_path / "mis-apuntes"
    make_pdf(folder / "a.pdf", ["Contenido de prueba A sobre atención."])
    (folder / "b.md").write_text("# B\n\nTransformers y atención.", encoding="utf-8")
    (folder / "ignorar.png").write_bytes(b"x")
    res = sources.add_paths(svc, "sub1", str(folder))
    assert {s["filename"] for s in res["sources"]} == {"a.pdf", "b.md"}
    s = _by_name(svc)["a.pdf"]
    assert s["origin"] == "path" and s["path"].endswith("a.pdf")
    assert not (svc.config.data_dir / "sources").exists() or not any((svc.config.data_dir / "sources").rglob("a.pdf"))


def test_installed_package_folder_is_discovered(svc):
    svc.store.put("installedPackage", {"id": "rn-pack", "subjectId": "sub1", "version": "1", "name": "x"})
    (svc.config.resources_dir / "rn-pack").mkdir()
    (svc.config.resources_dir / "rn-pack" / "extra.txt").write_text("Material del paquete instalado.", encoding="utf-8")
    counts = sources.scan_subject(svc, svc.store.get("subject", "sub1"))
    assert counts["new"] == 1


def test_split_text_bounds():
    text = " ".join(f"Frase {i} del texto de prueba." for i in range(400))
    parts = sources.split_text(text)
    assert all(len(p) <= sources.CHUNK_CHARS + 5 for p in parts)
    assert len(parts) > 5
    assert parts[0][-20:].strip()[-1] == "."  # cut at a sentence end
    assert sources.split_text("corto") == ["corto"]


def test_embeddings_stored_when_model_available(svc, resources, fake):
    fake.caps["embeddings"] = True
    counts = sources.scan_subject(svc, svc.store.get("subject", "sub1"))
    for sid in counts["pending"]:
        sources.index_source(svc, sid)
    n = rows(svc, "SELECT COUNT(*) AS n, MIN(dim) AS d, MAX(model) AS m FROM chunk_vecs")[0]
    total = rows(svc, "SELECT COUNT(*) AS n FROM chunks")[0]["n"]
    assert n["n"] == total and n["d"] == 64 and n["m"] == "fake-embeddings"


def test_word_per_line_pages_are_joined():
    from hypatia.notebook.sources import _clean

    stacked = "\n\n".join("Dilatación aumenta contornos y potencia detalles mientras la erosión reduce contornos".split() * 3)
    assert "\n" not in _clean(stacked)
    normal = "\n".join(["Una línea normal con varias palabras."] * 30)
    assert _clean(normal).count("\n") == 29
