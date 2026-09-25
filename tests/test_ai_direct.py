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
