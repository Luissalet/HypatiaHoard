import json

from hypatia.__main__ import main
from hypatia.hashing import compute_concept_hash


def test_import_backup_cli(tmp_path, monkeypatch):
    monkeypatch.setenv("HYPATIA_DATA_DIR", str(tmp_path / "data"))
    backup = {
        "version": 2, "kind": "full-backup", "exportedAt": "2026-09-25T10:00:00.000Z", "deviceId": "x",
        "subjects": [{"id": "s1", "name": "Visión Artificial", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}],
        "topics": [], "questions": [], "sessions": [], "pdfAnchors": [], "keyConcepts": [], "exams": [],
        "deliverables": [], "gradingConfigs": [], "syncedSettings": {"alias": "", "importedPackIds": []}, "questionImages": {},
    }
    f = tmp_path / "b.json"
    f.write_text(json.dumps(backup), encoding="utf-8")
    assert main(["import-backup", str(f)]) == 0
    assert main(["import-backup", str(f)]) == 0  # idempotent
    bad = tmp_path / "bad.json"
    bad.write_text("{}", encoding="utf-8")
    assert main(["import-backup", str(bad)]) == 2


def _package(tmp_path, package_id="vision-artificial"):
    import zipfile

    ts = "2026-08-29T10:00:00.000Z"
    manifest = {"formatVersion": 1, "id": package_id, "name": "Visión Artificial", "version": "1.2.0",
                "createdAt": ts, "updatedAt": ts, "stats": {"questions": 1, "topics": 1, "exams": 0, "keyConcepts": 0}}
    bank = {"formatVersion": 1, "subject": "vision-artificial",
            "topics": [{"id": "t1", "subjectId": "old", "title": "Tema 1", "order": 0, "createdAt": ts, "updatedAt": ts}],
            "questions": [{"id": "q1", "subjectId": "old", "topicId": "t1", "type": "DESARROLLO", "prompt": "¿Qué es un píxel?",
                           "modelAnswer": "La unidad mínima de una imagen.", "notes": "mine", "createdAt": ts, "updatedAt": ts,
                           "stats": {"seen": 9, "correct": 9, "wrong": 0}}],
            "keyConcepts": [{"id": "k1", "subjectId": "old", "category": "definition", "title": "Píxel",
                             "content": "Unidad mínima.", "order": 0, "createdAt": ts, "updatedAt": ts}]}
    pkg = tmp_path / "vision-artificial.examcoach.zip"
    with zipfile.ZipFile(pkg, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("bank.json", json.dumps(bank))
        zf.writestr("Temas/index.json", "[]")
        zf.writestr("Temas/Tema 1.pdf", b"%PDF-1.4 fake")
        zf.writestr("../evil.txt", "nope")
    return pkg


def _encrypt(data: bytes, password: str) -> bytes:
    import hashlib
    import os

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    salt, iv = os.urandom(16), os.urandom(12)
    key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000, dklen=32)
    return salt + iv + AESGCM(key).encrypt(iv, data, None)


def _check_installed(tmp_path):
    from hypatia.config import Config
    from hypatia.services import Services

    svc = Services(Config.from_env())
    try:
        subjects = svc.store.list("subject")
        assert [s["name"] for s in subjects] == ["Visión Artificial"]
        (q,) = svc.store.list("question")
        assert q["subjectId"] == subjects[0]["id"] and q["stats"]["seen"] == 0 and "notes" not in q
        (t,) = svc.store.list("topic")
        assert t["subjectId"] == subjects[0]["id"]
        (kc,) = svc.store.list("keyConcept")
        assert kc["contentHash"] == compute_concept_hash("definition", "Píxel", "Unidad mínima.")
        (pk,) = svc.store.list("installedPackage")
        assert pk["version"] == "1.2.0"
    finally:
        svc.stop()
    res = tmp_path / "res" / "vision-artificial"
    assert (res / "Temas" / "Tema 1.pdf").read_bytes() == b"%PDF-1.4 fake"
    assert not (tmp_path / "res" / "evil.txt").exists() and not (tmp_path / "evil.txt").exists()


def test_import_package_cli(tmp_path, monkeypatch):
    monkeypatch.setenv("HYPATIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("HYPATIA_RESOURCES_DIR", str(tmp_path / "res"))
    pkg = _package(tmp_path)
    assert main(["import-package", str(pkg)]) == 0
    assert main(["import-package", str(pkg)]) == 0  # second install merges into the same subject
    _check_installed(tmp_path)


def test_import_package_resources_follow_the_subject_name(tmp_path, monkeypatch):
    """The PWA reads resources/<slug of the subject name>/, whatever the package id is."""
    monkeypatch.setenv("HYPATIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("HYPATIA_RESOURCES_DIR", str(tmp_path / "res"))
    assert main(["import-package", str(_package(tmp_path, "va-2026"))]) == 0
    assert (tmp_path / "res" / "vision-artificial" / "Temas" / "Tema 1.pdf").is_file()
    assert not (tmp_path / "res" / "va-2026").exists()


def test_import_encrypted_package(tmp_path, monkeypatch):
    monkeypatch.setenv("HYPATIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("HYPATIA_RESOURCES_DIR", str(tmp_path / "res"))
    enc = tmp_path / "vision-artificial.examcoach.enc"
    enc.write_bytes(_encrypt(_package(tmp_path).read_bytes(), "s3creta"))
    assert main(["import-package", str(enc)]) == 2  # no password
    assert main(["import-package", str(enc), "--password", "mala"]) == 2
    table = tmp_path / "passwords.json"
    table.write_text(json.dumps({"vision-artificial": "s3creta"}), encoding="utf-8")
    assert main(["import-package", str(enc), "--passwords-file", str(table)]) == 0
    _check_installed(tmp_path)
