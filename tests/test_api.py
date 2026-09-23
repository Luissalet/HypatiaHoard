"""HTTP API through TestClient: decks, cards, review, stats, search, import/export, agent auth."""

from fixtures import CSV_SAMPLE, SAMPLE_CARDS


def test_health_and_local_only(client):
    assert client.get("/api/health").json() == {"service": "hypatia-hoard", "version": "0.1.0", "dataDirConfigured": True}
    assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 403
    assert client.get("/api/status", headers={"origin": "http://evil.example"}).status_code == 403
    assert client.get("/api/nope").status_code == 404


def test_default_deck_exists_and_decks_crud(client):
    decks = client.get("/api/decks").json()["decks"]
    assert any(d["name"] == "General" for d in decks)
    assert client.post("/api/decks", json={"name": ""}).status_code == 400
    created = client.post("/api/decks", json={"name": "Química", "new_per_day": 5}).json()
    assert created["new_per_day"] == 5
    again = client.post("/api/decks", json={"name": "quimica"}).json()  # idempotent, accent/case-insensitive
    assert again["id"] == created["id"]
    patched = client.patch(f"/api/decks/{created['id']}", json={"description": "Elementos"}).json()
    assert patched["description"] == "Elementos"
    assert client.patch("/api/decks/999", json={"name": "x"}).status_code == 404
    general = next(d for d in decks if d["name"] == "General")
    assert client.delete(f"/api/decks/{general['id']}").status_code == 400  # default deck needs ?with_cards=1
    assert client.delete(f"/api/decks/{created['id']}").json() == {"ok": True}
    assert client.delete(f"/api/decks/{created['id']}").status_code == 404


def test_deck_delete_moves_or_removes_cards(client):
    deck = client.post("/api/decks", json={"name": "Temporal"}).json()
    card = client.post("/api/cards", json={"deck": deck["id"], "front": "F", "back": "B"}).json()
    client.delete(f"/api/decks/{deck['id']}")
    moved = client.get(f"/api/cards/{card['id']}").json()
    general = next(d for d in client.get("/api/decks").json()["decks"] if d["name"] == "General")
    assert moved["deck_id"] == general["id"]

    deck2 = client.post("/api/decks", json={"name": "Temporal2"}).json()
    card2 = client.post("/api/cards", json={"deck": deck2["id"], "front": "F2", "back": "B2"}).json()
    client.delete(f"/api/decks/{deck2['id']}", params={"with_cards": 1})
    assert client.get(f"/api/cards/{card2['id']}").status_code == 404


def test_cards_add_single_and_list_with_dedupe(client):
    single = client.post("/api/cards", json={"deck": "Nuevo Mazo", "front": "¿Uno?", "back": "Sí"}).json()
    assert single["existing"] is False
    dup = client.post("/api/cards", json={"deck": "nuevo mazo", "front": "  ¿UNO?  ", "back": "Sí, corregido"}).json()
    assert dup["existing"] is True and dup["id"] == single["id"] and dup["back"] == "Sí, corregido"

    batch_payload = [{"deck": "Lote", **row} for row in SAMPLE_CARDS[:3]]
    batch = client.post("/api/cards", json=batch_payload).json()
    assert batch["cards"][0]["existing"] is False
    assert len(batch["cards"]) == 3


def test_cards_list_filters_and_validation(client):
    deck = client.post("/api/decks", json={"name": "Filtros"}).json()
    for row in SAMPLE_CARDS:
        client.post("/api/cards", json={"deck": deck["id"], **row})
    listing = client.get("/api/cards", params={"deck": deck["id"]}).json()
    assert listing["count"] == len(SAMPLE_CARDS)
    by_tag = client.get("/api/cards", params={"deck": deck["id"], "tag": "ciencia"}).json()
    assert all("ciencia" in c["tags"] for c in by_tag["cards"])
    due = client.get("/api/cards", params={"deck": deck["id"], "due": 1}).json()
    assert due["count"] == len(SAMPLE_CARDS)  # all new cards are immediately due
    assert client.post("/api/cards", json={"deck": deck["id"], "front": "", "back": "x"}).status_code == 400


def test_card_update_suspend_delete(client):
    card = client.post("/api/cards", json={"deck": "Editable", "front": "F", "back": "B", "tags": ["a"]}).json()
    patched = client.patch(f"/api/cards/{card['id']}", json={"back": "B2", "tags": ["a", "b"]}).json()
    assert patched["back"] == "B2" and set(patched["tags"]) == {"a", "b"}
    suspended = client.post(f"/api/cards/{card['id']}/suspend").json()
    assert suspended["suspended"] is True
    unsuspended = client.post(f"/api/cards/{card['id']}/unsuspend").json()
    assert unsuspended["suspended"] is False
    assert client.delete(f"/api/cards/{card['id']}").json() == {"ok": True}
    assert client.get(f"/api/cards/{card['id']}").status_code == 404
    assert client.patch("/api/cards/999999", json={"back": "x"}).status_code == 404


def test_review_queue_hides_back_and_review_grades(client):
    deck = client.post("/api/decks", json={"name": "Repaso"}).json()
    card = client.post("/api/cards", json={"deck": deck["id"], "front": "Pregunta", "back": "Secreta"}).json()
    queue = client.get("/api/review/queue", params={"deck": deck["id"]}).json()["queue"]
    assert queue and queue[0]["id"] == card["id"]
    assert "back" not in queue[0]  # never reveal the back through the queue

    result = client.post(f"/api/review/{card['id']}", json={"grade": "good", "elapsed_ms": 1200}).json()
    assert result["card"]["repetitions"] == 1
    assert result["card"]["state"] == "learning"
    assert client.post(f"/api/review/{card['id']}", json={"grade": 9}).status_code == 400
    assert client.post("/api/review/999999", json={"grade": 2}).status_code == 404


def test_stats_endpoint(client):
    deck = client.post("/api/decks", json={"name": "Stats"}).json()
    client.post("/api/cards", json={"deck": deck["id"], "front": "F", "back": "B"})
    stats = client.get("/api/stats", params={"deck": deck["id"]}).json()
    assert stats["cards"] == 1 and stats["new"] == 1 and stats["due_now"] == 1
    assert len(stats["forecast_7d"]) == 7
    assert client.get("/api/stats", params={"deck": 999999}).status_code == 404


def test_search_endpoint(client):
    deck = client.post("/api/decks", json={"name": "Buscar"}).json()
    for row in SAMPLE_CARDS:
        client.post("/api/cards", json={"deck": deck["id"], **row})
    result = client.get("/api/search", params={"q": "telescopio"}).json()
    assert result["count"] >= 1
    assert "<mark>" in (result["hits"][0]["back_snippet"] or result["hits"][0]["front_snippet"])


def test_import_export_json_and_csv(client):
    deck = client.post("/api/decks", json={"name": "ImportExport"}).json()
    imported = client.post(f"/api/decks/{deck['id']}/import", content=b'[{"front": "F1", "back": "B1", "tags": "x,y"}]').json()
    assert imported["created"] == 1
    imported_csv = client.post(f"/api/decks/{deck['id']}/import", content=CSV_SAMPLE.encode("utf-8")).json()
    assert imported_csv["created"] == 2
    reimport = client.post(f"/api/decks/{deck['id']}/import", content=b'[{"front": "F1", "back": "B1 actualizado"}]').json()
    assert reimport["updated"] == 1 and reimport["created"] == 0
    exported = client.get(f"/api/decks/{deck['id']}/export").json()
    assert len(exported) == 3
    assert {"ease", "interval_days", "state", "due_at"} <= set(exported[0])


def test_agent_tools_and_auth(client):
    catalog = client.get("/api/agent/tools").json()
    names = [t["name"] for t in catalog["tools"]]
    assert names == ["decks_list", "deck_create", "cards_add", "cards_due", "card_review", "cards_search",
                     "card_update", "card_delete", "cards_stats", "cards_export"]
    assert "sm-2" in catalog["instructions"].lower() or "grade" in catalog["instructions"].lower()
    for tool in catalog["tools"]:
        assert "Sinónimos:" in tool["description"] and tool["inputSchema"]["type"] == "object"
    write = next(t for t in catalog["tools"] if t["name"] == "cards_add")
    assert write["annotations"]["readOnlyHint"] is False
    destructive = next(t for t in catalog["tools"] if t["name"] == "card_delete")
    assert destructive["annotations"]["destructiveHint"] is True

    token = client.services.token
    assert client.post("/api/agent/call", json={"name": "decks_list"}).status_code == 401
    assert client.post("/api/agent/call", json={"name": "decks_list"}, headers={"Authorization": "Bearer nope"}).status_code == 401
    auth = {"Authorization": f"Bearer {token}"}
    assert client.post("/api/agent/call", json={"name": "unknown"}, headers=auth).status_code == 404

    deck = client.post("/api/agent/call", json={"name": "deck_create", "arguments": {"name": "Agente"}}, headers=auth).json()["deck"]
    added = client.post(
        "/api/agent/call",
        json={"name": "cards_add", "arguments": {"deck": "Agente", "cards": [{"front": "¿Uno?", "back": "Sí", "source": "test"}]}},
        headers=auth,
    ).json()
    assert added["count"] == 1
    card_id = added["cards"][0]["id"]

    due = client.post("/api/agent/call", json={"name": "cards_due", "arguments": {"deck": "Agente"}}, headers=auth).json()
    assert due["count"] == 1 and due["queue"][0]["back"] == "Sí"  # the agent DOES receive the back, to grade it

    graded = client.post("/api/agent/call", json={"name": "card_review", "arguments": {"id": card_id, "grade": "good"}}, headers=auth).json()
    assert graded["card"]["repetitions"] == 1

    stats = client.post("/api/agent/call", json={"name": "cards_stats", "arguments": {"deck": "Agente"}}, headers=auth).json()
    assert stats["cards"] == 1

    searched = client.post("/api/agent/call", json={"name": "cards_search", "arguments": {"q": "Uno"}}, headers=auth).json()
    assert searched["count"] >= 1

    exported = client.post("/api/agent/call", json={"name": "cards_export", "arguments": {"deck": "Agente"}}, headers=auth).json()
    assert len(exported["cards"]) == 1

    updated = client.post("/api/agent/call", json={"name": "card_update", "arguments": {"id": card_id, "suspended": True}}, headers=auth).json()
    assert updated["suspended"] is True

    deleted = client.post("/api/agent/call", json={"name": "card_delete", "arguments": {"id": card_id}}, headers=auth).json()
    assert deleted["ok"] is True
    assert client.post("/api/agent/call", json={"name": "card_review", "arguments": {"id": card_id, "grade": "good"}}, headers=auth).status_code == 404
