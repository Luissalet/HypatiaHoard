"""The shared native relay keeps identity server-side across JSON, uploads and streams."""

import base64
import gzip
import json

import httpx


def upstream(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *args, **kwargs:
                        original(*args, **{**kwargs, "transport": httpx.MockTransport(handler)}))


def test_info_space_stable_and_origin_server_owned(client, monkeypatch):
    received = []

    def handle(request):
        if request.url.path.endswith('/capabilities'):
            return httpx.Response(200, json={"contract_version": "1.0"})
        received.append(json.loads(request.content))
        return httpx.Response(200, json={"session_id": "private"})

    upstream(monkeypatch, handle)
    first = client.get('/api/copilot/info').json()
    assert first == client.get('/api/copilot/info').json()
    assert first['app_id'] == 'hypatia' and first['data_space_id']
    assert not any(key in first for key in ('token', 'authorization', 'faustus_token'))
    response = client.post('/api/copilot/proxy', json={"path": "/api/hoard-copilot/sessions", "method": "POST",
        "body": {"context": {"origin": {"app_id": "forged", "data_space_id": "fake"}, "view": {"editor": {"draft": "Unchanged"}}}}})
    assert response.status_code == 200
    assert received[0]['context']['origin']['app_id'] == 'hypatia'
    assert received[0]['context']['origin']['data_space_id'] == first['data_space_id']
    assert received[0]['context']['view']['editor']['draft'] == 'Unchanged'


def test_stream_gzip_and_upstream_error(client, monkeypatch):
    def handle(request):
        if request.url.path.endswith('/capabilities'):
            return httpx.Response(200, json={"contract_version": "1.0"})
        if request.url.path.endswith('/panel.js'):
            return httpx.Response(200, content=gzip.compress(b'export const nativePanel = true;'),
                                  headers={'content-type': 'application/javascript', 'content-encoding': 'gzip'})
        return httpx.Response(502, content=b'data: {"error":"upstream"}\n\n',
                              headers={'content-type': 'text/event-stream', 'x-odysseus-run-id': 'qa'})
    upstream(monkeypatch, handle)
    panel = client.get('/api/copilot/panel.js')
    assert panel.content == b'export const nativePanel = true;'
    assert 'content-encoding' not in panel.headers
    stream = client.post('/api/copilot/proxy', json={'path': '/api/chat_stream', 'method': 'POST', 'body': {}})
    assert stream.status_code == 502 and stream.content.endswith(b'\n\n')
    assert stream.headers['x-odysseus-run-id'] == 'qa'


def test_multipart_preserves_file_and_rewrites_origin(client, monkeypatch):
    received = []
    def handle(request):
        if request.url.path.endswith('/capabilities'):
            return httpx.Response(200, json={'contract_version': '1.0'})
        received.append(request.content)
        return httpx.Response(200, json={'ok': True})
    upstream(monkeypatch, handle)
    body = (b'--edge\r\nContent-Disposition: form-data; name="hoard_context"\r\n\r\n'
            b'{"origin":{"app_id":"fake"}}\r\n--edge\r\n'
            b'Content-Disposition: form-data; name="file"; filename="qa.bin"\r\n'
            b'Content-Type: application/octet-stream\r\n\r\n\x00\xff\r\n--edge--\r\n')
    response = client.post('/api/copilot/proxy', json={'path': '/api/chat_stream', 'method': 'POST',
        'raw_body': base64.b64encode(body).decode(), 'content_type': 'multipart/form-data; boundary=edge'})
    assert response.status_code == 200
    assert b'\x00\xff\r\n--edge--\r\n' in received[0]
    assert b'"app_id": "hypatia"' in received[0] and b'"app_id":"fake"' not in received[0]
    assert client.post('/api/copilot/proxy', json={'path': 'https://example.invalid/'}).status_code == 400


def test_manifest_declares_native_copilot():
    from pathlib import Path
    manifest = json.loads((Path(__file__).resolve().parents[1] / 'faustus-plugin.json').read_text(encoding='utf8'))
    assert manifest['x-family']['copilot']['context'] == 'native-records'


def test_nested_header_patch_preserves_agent_and_user_fields(client):
    from hypatia.teacher.store import TeacherStore
    from hypatia.agent_tools import call_tool
    store = TeacherStore(client.services)
    store.put('teacherExam', {'id': 'header', 'title': 'QA', 'header': {'centre': 'Old centre', 'course': 'Old course'}})
    call_tool(client.services, 'record_patch', {'kind': 'teacherExam', 'id': 'header',
        'patch': {'header': {'course': 'Agent course'}}, 'merge_objects': True})
    response = client.patch('/api/bank/records/teacherExam/header?merge_objects=true',
                            json={'header': {'centre': 'User centre'}})
    assert response.status_code == 200
    assert response.json()['record']['header'] == {'centre': 'User centre', 'course': 'Agent course'}
    # The approved default remains a whole-field replacement.
    replacement = client.patch('/api/bank/records/teacherExam/header', json={'header': {'centre': 'Replacement'}})
    assert replacement.json()['record']['header'] == {'centre': 'Replacement'}
