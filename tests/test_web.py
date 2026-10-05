import pytest
from fastapi.testclient import TestClient

from dev_requests.models import ResponseData
from dev_requests.web import server
from dev_requests.web.server import create_app

HEADERS = {"X-Dev-Requests": "1"}


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(tmp_path / "h.json"), base_url="http://127.0.0.1")


def test_index_served(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "dev_requests" in res.text


def test_send_and_history(client, monkeypatch):
    async def fake_send(spec):
        assert spec.url == "https://api.test/users"
        return ResponseData(status=200, reason="OK", body_text='{"a": 1}')

    monkeypatch.setattr(server, "send", fake_send)

    res = client.post("/api/send", headers=HEADERS, json={"request": {"method": "GET", "url": "https://api.test/users"}})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == 200
    assert body["error"] is None

    history = client.get("/api/history", headers=HEADERS).json()
    assert len(history) == 1
    assert history[0]["request"]["url"] == "https://api.test/users"

    assert client.delete("/api/history", headers=HEADERS).status_code == 200
    assert client.get("/api/history", headers=HEADERS).json() == []


def test_api_requires_client_header(client):
    assert client.get("/api/history").status_code == 403


def test_rejects_foreign_host(tmp_path):
    client = TestClient(create_app(tmp_path / "h.json"), base_url="http://evil.example")
    assert client.get("/").status_code == 403


def test_send_resolves_variables_but_history_keeps_placeholders(client, monkeypatch):
    sent = {}

    async def fake_send(spec):
        sent["spec"] = spec
        return ResponseData(status=200, reason="OK")

    monkeypatch.setattr(server, "send", fake_send)

    project = client.post("/api/projects", headers=HEADERS, json={"name": "API"}).json()
    env = project["environments"][0]
    env["variables"] = [
        {"key": "base", "value": "https://dev.test"},
        {"key": "token", "value": "s3cr3t", "secret": True},
    ]
    assert client.put(f"/api/projects/{project['id']}", headers=HEADERS, json=project).status_code == 200
    client.put("/api/globals", headers=HEADERS, json=[{"key": "nome", "value": "ana"}, {"key": "base", "value": "global"}])

    res = client.post("/api/send", headers=HEADERS, json={
        "project_id": project["id"],
        "environment_id": env["id"],
        "request": {
            "url": "{{base}}/u?n={{nome}}&x={{nada}}",
            "auth": {"type": "bearer", "token": "{{token}}"},
        },
    }).json()

    assert sent["spec"].url == "https://dev.test/u?n=ana&x={{nada}}"
    assert sent["spec"].auth.token == "s3cr3t"
    assert res["resolved_url"] == "https://dev.test/u?n=ana&x={{nada}}"
    assert res["unresolved"] == ["nada"]

    entry = client.get("/api/history", headers=HEADERS).json()[0]["request"]
    assert entry["auth"]["token"] == "{{token}}"
    assert "s3cr3t" not in str(entry)


def test_project_endpoints(client):
    projects = client.get("/api/projects", headers=HEADERS).json()
    assert [p["name"] for p in projects] == ["Meu projeto"]

    created = client.post("/api/projects", headers=HEADERS, json={"name": "Outro"}).json()
    assert client.get(f"/api/projects/{created['id']}", headers=HEADERS).json()["name"] == "Outro"

    exported = client.get(f"/api/projects/{created['id']}/export", headers=HEADERS).json()
    imported = client.post("/api/projects/import", headers=HEADERS, json=exported).json()
    assert imported["id"] != created["id"]

    assert client.delete(f"/api/projects/{created['id']}", headers=HEADERS).status_code == 200
    assert client.get(f"/api/projects/{created['id']}", headers=HEADERS).status_code == 404
    assert client.get("/api/projects/..%2Fetc", headers=HEADERS).status_code == 404


FIXTURES = __import__("pathlib").Path(__file__).parent / "fixtures"


@pytest.mark.parametrize("fixture,fmt,name", [
    ("insomnia_v4.json", "insomnia-v4", "Loja API"),
    ("insomnia_v5.yaml", "insomnia-v5", "Loja API v5"),
])
def test_import_insomnia_files(client, fixture, fmt, name):
    res = client.post("/api/import", headers=HEADERS, content=(FIXTURES / fixture).read_bytes())
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["format"] == fmt
    assert [p["name"] for p in body["projects"]] == [name]
    assert body["warnings"]
    project = client.get(f"/api/projects/{body['projects'][0]['id']}", headers=HEADERS).json()
    assert project["requests"][0]["name"] == "Listar produtos"


def test_import_dev_requests_and_invalid(client):
    pid = client.get("/api/projects", headers=HEADERS).json()[0]["id"]
    exported = client.get(f"/api/projects/{pid}/export", headers=HEADERS).text
    res = client.post("/api/import", headers=HEADERS, content=exported.encode())
    assert res.json()["format"] == "dev_requests"

    bad = client.post("/api/import", headers=HEADERS, content=b"isso nao e um export")
    assert bad.status_code == 400
    assert "formato não reconhecido" in bad.json()["detail"]


def test_export_formats(client):
    pid = client.get("/api/projects", headers=HEADERS).json()[0]["id"]
    v4 = client.get(f"/api/projects/{pid}/export?format=insomnia-v4", headers=HEADERS)
    assert v4.headers["content-type"].startswith("application/json")
    assert v4.json()["__export_format"] == 4

    v5 = client.get(f"/api/projects/{pid}/export?format=insomnia-v5", headers=HEADERS)
    assert v5.headers["content-type"].startswith("application/yaml")
    assert v5.text.startswith("type: collection.insomnia.rest/5.0")

    assert client.get(f"/api/projects/{pid}/export?format=postman", headers=HEADERS).status_code == 400
