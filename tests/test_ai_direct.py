"""A resident llama.cpp server is called directly: long timeout, thinking off."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

from hypatia import ai


class _Handler(BaseHTTPRequestHandler):
    seen: list = []

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _Handler.seen.append((self.path, body))
        out = json.dumps({"choices": [{"message": {"content": "<think>hmm</think>Hola [1]"}}],
                          "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


class _Link:
    def __init__(self, res):
        self.res = res
        self.chat_calls = 0

    async def resolve(self, capability):
        return self.res

    async def chat(self, messages, **kwargs):
        self.chat_calls += 1
        return SimpleNamespace(text="via link", model="m")


def _run(coro):
    import asyncio
    return asyncio.run(coro)


def test_resident_llamacpp_is_called_directly_without_thinking():
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/v1/chat/completions"
        link = _Link(SimpleNamespace(resolved=True, provider="llamacpp", api="openai", url=url, model="big",
                                     details={"resident": True}))
        result = _run(ai.link_chat(link, [{"role": "user", "content": "hola"}], max_tokens=50, temperature=0.1,
                                   response_format={"type": "json_object"}))
        assert result.text == "Hola [1]" and result.reasoning == "hmm" and result.usage.total_tokens == 5
        assert link.chat_calls == 0
        path, body = _Handler.seen[-1]
        assert path == "/v1/chat/completions" and body["chat_template_kwargs"] == {"enable_thinking": False}
        assert body["max_tokens"] == 50 and body["response_format"] == {"type": "json_object"}
    finally:
        server.shutdown()


class _OllamaHandler(_Handler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _Handler.seen.append((self.path, body))
        out = json.dumps({"message": {"role": "assistant", "content": "{\"ok\": true}"},
                          "prompt_eval_count": 7, "eval_count": 3}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def test_resident_ollama_is_called_directly_without_thinking():
    server = HTTPServer(("127.0.0.1", 0), _OllamaHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        link = _Link(SimpleNamespace(resolved=True, provider="ollama", api="ollama",
                                     url=f"http://127.0.0.1:{server.server_port}", model="qwen",
                                     details={"resident": True}))
        result = _run(ai.link_chat(link, [{"role": "user", "content": "x"}], max_tokens=20, temperature=0,
                                   response_format={"type": "json_object"}))
        assert result.text == '{"ok": true}' and result.usage.completion_tokens == 3 and link.chat_calls == 0
        path, body = _Handler.seen[-1]
        assert path == "/api/chat" and body["think"] is False and body["format"] == "json"
        assert body["options"] == {"temperature": 0, "num_predict": 20}
    finally:
        server.shutdown()


def test_other_backends_go_through_link():
    link = _Link(SimpleNamespace(resolved=True, provider="faustus_llm", api="openai", url="http://x", model="m",
                                 details={"resident": True}))
    assert _run(ai.link_chat(link, [{"role": "user", "content": "x"}])).text == "via link"
    link = _Link(SimpleNamespace(resolved=True, provider="llamacpp", api="openai", url="http://x", model="m",
                                 details={"resident": False}))
    assert _run(ai.link_chat(link, [{"role": "user", "content": "x"}])).text == "via link"


def test_a_call_that_asks_to_think_gets_its_level_and_room(monkeypatch):
    """Quality work (a study guide) asks for `max`: the direct call turns
    thinking on with the budget llama-server honours and room for it."""
    monkeypatch.delenv("HYPATIA_LLM_EFFORT", raising=False)
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/v1/chat/completions"
        link = _Link(SimpleNamespace(resolved=True, provider="llamacpp", api="openai", url=url, model="big",
                                     details={"resident": True}))
        result = _run(ai.link_chat(link, [{"role": "user", "content": "guia"}], max_tokens=4000, effort="max"))
        _path, body = _Handler.seen[-1]
        assert body["chat_template_kwargs"] == {"enable_thinking": True}
        assert body["thinking_budget_tokens"] == 16384 and body["max_tokens"] == 4000 + 16384
        assert result.effort == "max"
    finally:
        server.shutdown()


def test_owner_knob_forces_one_level(monkeypatch):
    monkeypatch.setenv("HYPATIA_LLM_EFFORT", "off")
    assert ai.llm_effort("max") == "off"
    monkeypatch.delenv("HYPATIA_LLM_EFFORT")
    assert ai.llm_effort("high") == "high"
    assert ai.llm_effort(None) == "off"


def test_non_direct_calls_pass_the_level_to_link(monkeypatch):
    monkeypatch.delenv("HYPATIA_LLM_EFFORT", raising=False)
    seen = {}

    class _L(_Link):
        async def chat(self, messages, **kwargs):
            seen.update(kwargs)
            return SimpleNamespace(text="ok", model="m")

    link = _L(SimpleNamespace(resolved=True, provider="faustus", api="openai", url="http://x/v1", model="m",
                              details={"resident": False}))
    _run(ai.link_chat(link, [{"role": "user", "content": "x"}], effort="medium"))
    assert seen["effort"] == "medium"


class _PickyTemplateHandler(_Handler):
    """A llama.cpp whose chat template raises on the reasoning effort it is given."""

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _Handler.seen.append((self.path, body))
        if "reasoning_effort" in body:
            out = json.dumps({"error": {"code": 500, "message": "\n------------\nWhile executing CallExpression at line 49, "
                                        "column 28 in source:\n...{{ raise_exception('Unexpected reasoning effort ' + reasoning_effort) }}"}}).encode()
            self.send_response(500)
        else:
            out = json.dumps({"choices": [{"message": {"content": "Pregunta generada"}}]}).encode()
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def test_a_template_that_refuses_the_effort_gets_the_call_again_without_it():
    _Handler.seen = []
    server = HTTPServer(("127.0.0.1", 0), _PickyTemplateHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/v1/chat/completions"
        link = _Link(SimpleNamespace(resolved=True, provider="llamacpp", api="openai", url=url, model="big",
                                     details={"resident": True}))
        result = _run(ai.link_chat(link, [{"role": "user", "content": "hola"}], max_tokens=50, effort="high"))
        assert result.text == "Pregunta generada"
        first, last = _Handler.seen[0][1], _Handler.seen[-1][1]
        assert first["reasoning_effort"] == "high"
        assert "reasoning_effort" not in last and "enable_thinking" not in last.get("chat_template_kwargs", {})
    finally:
        server.shutdown()
