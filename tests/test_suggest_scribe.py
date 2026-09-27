import pytest

from hypatia.suggest import SuggestInputError, _from_scribe


class TranscriptClient:
    def __init__(self, sessions=None, transcripts=None):
        self.session_rows = sessions or []
        self.transcripts = transcripts or {}

    def sessions(self, **kwargs):
        return {"sessions": self.session_rows}

    def full_transcript(self, session_id, max_total_chars):
        return self.transcripts[session_id]


def test_single_session_label_uses_funes_audio_branding():
    client = TranscriptClient(transcripts={"session-1": ("[00:03] yo: Intro", {"title": "Cell biology"})})

    result = _from_scribe(client, "session-1", None, None)

    assert result == ("[00:03] yo: Intro", "Funes audio: Cell biology", False)


def test_session_range_label_uses_funes_audio_branding():
    client = TranscriptClient(
        sessions=[{"id": "session-1"}, {"id": "session-2"}],
        transcripts={
            "session-1": ("[00:03] yo: Intro", {"title": "Cell biology"}),
            "session-2": ("[00:08] otros: Membrane", {"title": "Cell membrane"}),
        },
    )

    transcript, label, truncated = _from_scribe(client, None, "2026-01-01", "2026-01-02")

    assert transcript == "## Cell biology\n[00:03] yo: Intro\n\n## Cell membrane\n[00:08] otros: Membrane"
    assert label == "Funes audio: Cell biology, Cell membrane"
    assert truncated is False


def test_session_range_requires_a_session_id_or_date_bound():
    with pytest.raises(SuggestInputError, match="Funes audio source needs session_id"):
        _from_scribe(TranscriptClient(), None, None, None)
