import json

import httpx

from hypatia import scribe_client


def _clear_scribe_env(monkeypatch):
    for name in (
        "SCRIBE_URL", "SCRIBE_TOKEN", "SCRIBE_TOKEN_FILE", "SCRIBE_DATA_DIR",
        "FUNES_URL", "FUNES_DIR", "FUNES_DATA_DIR", "FUNES_AUDIO_TOKEN_FILE",
    ):
        monkeypatch.delenv(name, raising=False)


def test_defaults_to_funes_audio_mount_and_token(tmp_path, monkeypatch):
    _clear_scribe_env(monkeypatch)
    hypatia_root = tmp_path / "Hypatia's Hoard"
    funes_root = tmp_path / "Funes's Hoard"
    (funes_root / "data" / "audio").mkdir(parents=True)
    (funes_root / "data" / "url").write_text("http://127.0.0.1:9913/\n", encoding="utf-8")
    (funes_root / "data" / "audio" / "mcp-token").write_text("audio-token\n", encoding="utf-8")
    monkeypatch.setattr(scribe_client, "REPO_ROOT", hypatia_root)

    assert scribe_client.resolve_url() == "http://127.0.0.1:9913/audio"
    assert scribe_client.resolve_token() == "audio-token"


def test_falls_back_to_funes_audio_default_url(tmp_path, monkeypatch):
    _clear_scribe_env(monkeypatch)
    monkeypatch.setattr(scribe_client, "REPO_ROOT", tmp_path / "Hypatia's Hoard")

    assert scribe_client.resolve_url() == "http://127.0.0.1:8813/audio"


def test_explicit_overrides_and_custom_funes_data_dir(tmp_path, monkeypatch):
    _clear_scribe_env(monkeypatch)
    custom_data = tmp_path / "Funes data"
    token_path = custom_data / "audio" / "mcp-token"
    token_path.parent.mkdir(parents=True)
    token_path.write_text("custom-audio-token", encoding="utf-8")
    monkeypatch.setenv("FUNES_DATA_DIR", str(custom_data))
    monkeypatch.setenv("FUNES_URL", "http://funes.local:9900/")

    assert scribe_client.resolve_url() == "http://funes.local:9900/audio"
    assert scribe_client.resolve_token() == "custom-audio-token"

    monkeypatch.setenv("SCRIBE_URL", "http://override.local/audio/")
    monkeypatch.setenv("SCRIBE_TOKEN", "explicit-token")
    assert scribe_client.resolve_url() == "http://override.local/audio"
    assert scribe_client.resolve_token() == "explicit-token"


def test_client_calls_funes_audio_and_preserves_agent_tool_contract():
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"sessions": [{"id": "session-1"}]})

    client = scribe_client.ScribeClient(
        base_url="http://funes.local/audio",
        token="test-token",
        transport=httpx.MockTransport(respond),
    )

    result = client.sessions(from_="2026-01-01", limit=5)

    assert result == {"sessions": [{"id": "session-1"}]}
    assert requests[0].url == "http://funes.local/audio/api/agent/call"
    assert requests[0].headers["Authorization"] == "Bearer test-token"
    assert json.loads(requests[0].content) == {
        "name": "scribe_sessions",
        "arguments": {"from": "2026-01-01", "limit": 5},
    }


def test_full_transcript_keeps_existing_text_and_metadata_shape():
    pages = [
        {
            "session": {"title": "Class"},
            "segments": [{"t": "00:02", "speaker": "yo", "text": "First"}],
            "next_from_s": 2.5,
        },
        {
            "session": {"title": "Class"},
            "segments": [{"t": "00:03", "speaker": "otros", "text": "Second"}],
            "next_from_s": None,
        },
    ]
    client = scribe_client.ScribeClient(base_url="http://funes.local/audio", token="test-token")
    calls = []

    def transcript_page(session_id, from_s=None, max_chars=60000):
        calls.append((session_id, from_s, max_chars))
        return pages[len(calls) - 1]

    client.transcript_page = transcript_page

    transcript, metadata = client.full_transcript("session-1", max_total_chars=1000)

    assert transcript == "[00:02] yo: First\n[00:03] otros: Second"
    assert metadata == {"title": "Class"}
    assert calls == [("session-1", None, 60000), ("session-1", 2.5, 60000)]
