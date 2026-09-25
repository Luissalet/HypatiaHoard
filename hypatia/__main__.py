"""`python -m hypatia` — run the server on 127.0.0.1.
`python -m hypatia migrate-hypatia <old hypatia-hoard.db>` — import the old flashcard app.
`python -m hypatia import-backup <examcoach-backup.json>` — merge an Exam Coach full backup (the Gist sync file).
`python -m hypatia import-package <subject.examcoach.enc|.zip> [--password P | --passwords-file F]` — install a subject package."""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

from .config import Config


def serve() -> None:
    import uvicorn

    from .main import create_app
    from .port import find_available_port

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    config = Config.from_env()
    config.port = config.port if config.port_strict else find_available_port(config.port)
    app = create_app(config)
    print(f"Hypatia's Hoard listening on http://127.0.0.1:{config.port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=config.port, log_level="warning")


def migrate(path: str) -> int:
    from .migrate_hypatia import migrate as run
    from .services import Services

    svc = Services(Config.from_env())
    try:
        report = run(svc, Path(path).expanduser())
    finally:
        svc.stop()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("Done. If the server is running, the PWA picks the questions up on its next sync.")
    return 0


def import_backup(path: str) -> int:
    from .services import Services
    from .sync import push

    raw = json.loads(Path(path).expanduser().read_text(encoding="utf-8-sig"))
    backup = raw.get("backup", raw) if isinstance(raw, dict) else None
    if not isinstance(backup, dict) or backup.get("kind") != "full-backup":
        print("Not an Exam Coach full backup (kind 'full-backup').", file=sys.stderr)
        return 2
    svc = Services(Config.from_env())
    try:
        report = push(svc.store, backup, [], "import-backup", svc.now_iso())
    finally:
        svc.stop()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


PBKDF2_ITERATIONS = 100_000
RESOURCE_FOLDERS = ("Temas", "Examenes", "Resumenes", "Practica")


def decrypt_package(data: bytes, password: str) -> bytes:
    """`.examcoach.enc` -> zip bytes. Same format as the PWA's packageCrypto.ts:
    16-byte salt + 12-byte IV + AES-256-GCM ciphertext+tag, key = PBKDF2-SHA256 (100k)."""
    import hashlib

    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if len(data) < 16 + 12 + 16:
        raise ValueError("The package is too short to be an encrypted .examcoach.enc")
    salt, iv, ciphertext = data[:16], data[16:28], data[28:]
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS, dklen=32)
    try:
        return AESGCM(key).decrypt(iv, ciphertext, None)
    except InvalidTag as error:
        raise ValueError("Wrong password for this package") from error


def read_package(path: Path, password: str | None) -> bytes:
    data = path.read_bytes()
    if data[:4] == b"PK\x03\x04":  # a plain zip
        return data
    if not password:
        raise ValueError(f"{path.name} is encrypted: pass --password (or --passwords-file)")
    return decrypt_package(data, password)


def package_backup(zip_bytes: bytes, now_iso: str) -> tuple[dict, dict]:
    """A package zip (manifest.json + bank.json) as a FullBackup for the merge, plus its manifest.

    Same outcome as the PWA's installPackage: one subject named after the
    manifest (reused by slug), the bank's topics/questions/concepts/exams/
    anchors under it with fresh stats, and an installedPackages record so the
    PWA's marketplace sees it installed and can offer updates.
    """
    import io
    import uuid
    import zipfile

    from .hashing import compute_concept_hash

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        manifest = json.loads(zf.read("manifest.json").decode("utf-8-sig"))
        bank = json.loads(zf.read("bank.json").decode("utf-8-sig"))
    if not manifest.get("id") or not manifest.get("name") or not manifest.get("version"):
        raise ValueError("manifest.json is missing id, name or version")
    subject_id = str(uuid.uuid4())
    subject = {"id": subject_id, "name": manifest["name"], "createdAt": now_iso, "updatedAt": now_iso}
    if manifest.get("allowsNotes") is not None:
        subject["allowsNotes"] = manifest["allowsNotes"]

    def under_subject(items):
        return [{**item, "subjectId": subject_id} for item in items or [] if isinstance(item, dict)]

    questions = []
    for q in under_subject(bank.get("questions")):
        q.pop("notes", None)
        q.pop("starred", None)
        q["stats"] = {"seen": 0, "correct": 0, "wrong": 0}
        q.setdefault("createdAt", now_iso)
        q.setdefault("updatedAt", now_iso)
        questions.append(q)
    # Concepts carry their hash so a later JSON import of the same concepts deduplicates
    # (keyConceptsImport.ts compares stored hashes only).
    concepts = under_subject(bank.get("keyConcepts"))
    for c in concepts:
        if not c.get("contentHash"):
            c["contentHash"] = compute_concept_hash(str(c.get("category") or ""), c.get("title") or "", c.get("content") or "")
    backup = {
        "version": 2, "kind": "full-backup", "exportedAt": now_iso, "deviceId": "import-package",
        "subjects": [subject],
        "topics": under_subject(bank.get("topics")),
        "questions": questions,
        "sessions": [],
        "pdfAnchors": under_subject(bank.get("pdfAnchors")),
        "keyConcepts": concepts,
        "exams": under_subject(bank.get("exams")),
        "deliverables": [], "gradingConfigs": [],
        "syncedSettings": {"alias": "", "importedPackIds": []},
        "questionImages": {},
        "installedPackages": [{"id": manifest["id"], "subjectId": subject_id, "version": manifest["version"],
                               "name": manifest["name"], "installedAt": now_iso, "manifest": manifest}],
    }
    return backup, manifest


def extract_resources(zip_bytes: bytes, dest: Path) -> int:
    """Copy the package's Temas/Examenes/Resumenes/Practica files to resources/<subject slug>/,
    where the notebook indexes them and the PWA's /resources/ reads them. Local only
    (resources/ is gitignored). Never writes outside `dest`."""
    import io
    import zipfile

    dest = dest.resolve()
    count = 0
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if info.is_dir() or name.split("/", 1)[0] not in RESOURCE_FOLDERS:
                continue
            target = (dest / name).resolve()
            if dest not in target.parents:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            data = zf.read(info)
            if target.is_file() and target.stat().st_size == len(data):
                continue
            target.write_bytes(data)
            count += 1
    return count


def import_package(path: str, password: str | None) -> int:
    from .hashing import slugify
    from .services import Services
    from .sync import push

    svc = Services(Config.from_env())
    try:
        zip_bytes = read_package(Path(path).expanduser(), password)
        backup, manifest = package_backup(zip_bytes, svc.now_iso())
        report = push(svc.store, backup, [], "import-package", svc.now_iso())
        # resources/<slug of the subject name>: where the PWA looks (the notebook also accepts the package id).
        report["resources"] = extract_resources(zip_bytes, svc.config.resources_dir / slugify(manifest["name"]))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    finally:
        svc.stop()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("Done. The PWA picks it up on its next sync; POST /api/notebook/sources/rescan indexes the PDFs.")
    return 0


def _package_password(args: list[str], path: str) -> str | None:
    if "--password" in args:
        return args[args.index("--password") + 1]
    if "--passwords-file" in args:
        table = json.loads(Path(args[args.index("--passwords-file") + 1]).read_text(encoding="utf-8-sig"))
        stem = Path(path).name.split(".examcoach")[0]
        return table.get(stem) if isinstance(table, dict) else None
    return os.environ.get("HYPATIA_PACKAGE_PASSWORD") or None


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args and args[0] == "migrate-hypatia":
        if len(args) != 2:
            print("usage: python -m hypatia migrate-hypatia <path-to-old hypatia-hoard.db>", file=sys.stderr)
            return 2
        return migrate(args[1])
    if args and args[0] == "import-backup":
        if len(args) != 2:
            print("usage: python -m hypatia import-backup <examcoach-backup.json>", file=sys.stderr)
            return 2
        return import_backup(args[1])
    if args and args[0] == "import-package":
        if len(args) not in (2, 4) or (len(args) == 4 and args[2] not in ("--password", "--passwords-file")):
            print("usage: python -m hypatia import-package <subject.examcoach.enc|.zip> [--password P | --passwords-file F]",
                  file=sys.stderr)
            return 2
        return import_package(args[1], _package_password(args, args[1]))
    if args:
        print(f"Unknown command: {args[0]}. Usage: python -m hypatia [migrate-hypatia <old.db> | import-backup <backup.json> | import-package <pkg> [--password P]]", file=sys.stderr)
        return 2
    serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
