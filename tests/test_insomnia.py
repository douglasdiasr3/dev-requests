from pathlib import Path

import pytest
import yaml

from reqresp import insomnia
from reqresp.models import AuthConfig, RequestSpec
from reqresp.projects import Environment, Project, SavedRequest, Variable

FIXTURES = Path(__file__).parent / "fixtures"


def load(name):
    return insomnia.load_any((FIXTURES / name).read_text())


def by_name(project):
    return {r.name: r.request for r in project.requests}


def env_vars(project, env_name):
    env = next(e for e in project.environments if e.name == env_name)
    return {v.key: (v.value, v.secret) for v in env.variables}


# ---------- detecção ----------

def test_detect_formats():
    assert insomnia.detect(load("insomnia_v4.json")) == "insomnia-v4"
    assert insomnia.detect(load("insomnia_v5.yaml")) == "insomnia-v5"
    assert insomnia.detect({"name": "x", "requests": [], "environments": []}) == "reqresp"
    with pytest.raises(ValueError, match="formato não reconhecido"):
        insomnia.detect({"foo": 1})
    with pytest.raises(ValueError, match="só um ambiente"):
        insomnia.detect({"type": "environment.insomnia.rest/5.0"})
    with pytest.raises(ValueError, match="JSON nem YAML"):
        insomnia.load_any("{a: [")


# ---------- importação v4 ----------

def test_v4_requests():
    result = insomnia.from_v4(load("insomnia_v4.json"))
    (project,) = result.projects
    assert project.name == "Loja API"
    assert [r.name for r in project.requests] == [
        "Listar produtos",
        "Criar produto",
        "Admin / Usuários",
        "Admin / Relatórios / Filtrar",
        "Admin / Relatórios / Upload",
    ]
    reqs = by_name(project)

    listar = reqs["Listar produtos"]
    assert listar.url == "{{base_url}}/{{api.version}}/produtos"
    assert listar.params == [("page", "1")], "params desabilitados são descartados"
    assert listar.auth == AuthConfig(type="bearer", token="{{token}}")

    criar = reqs["Criar produto"]
    assert criar.body_type == "json"
    assert '"preco": {{preco}}' in criar.body
    assert ("Content-Type", "application/json") not in criar.headers, "redundante com body JSON"
    assert criar.auth == AuthConfig(type="basic", username="admin", password="{{senha}}")

    users = reqs["Admin / Usuários"]
    assert users.headers == [("X-Admin", "1"), ("Authorization", "Token {{token}}")], \
        "header e auth (prefixo customizado) herdados da pasta"
    assert users.auth.type == "none"

    filtrar = reqs["Admin / Relatórios / Filtrar"]
    assert filtrar.body_type == "text"
    assert filtrar.body == "de=2024-01-01&ate={{hoje}}"
    assert ("Content-Type", "application/x-www-form-urlencoded") in filtrar.headers
    assert ("X-Api-Key", "abc") in filtrar.headers

    upload = reqs["Admin / Relatórios / Upload"]
    assert upload.body_type == "none"
    assert upload.auth.type == "none"


def test_v4_environments_and_warnings():
    result = insomnia.from_v4(load("insomnia_v4.json"))
    (project,) = result.projects
    assert [e.name for e in project.environments] == ["Dev", "Prod"]
    assert project.active_env_id == project.environments[0].id

    dev = env_vars(project, "Dev")
    assert dev["base_url"] == ("https://api.loja.dev", False)
    assert dev["api.version"] == ("v2", False), "data aninhado é achatado"
    assert dev["timeout"] == ("30", False)
    assert dev["admin_path"] == ("/admin", False), "variáveis de pasta vão para todos os ambientes"

    prod = env_vars(project, "Prod")
    assert prod["base_url"] == ("https://api.loja.com", True), "sub-ambiente vence a base; privado vira secreto"
    assert prod["api.version"] == ("v2", False), "variável herdada da base não fica secreta"

    text = "\n".join(result.warnings)
    for expected in ["{% uuid %}", "form-urlencoded", "multipart", '"oauth2"', "foram ignoradas: Socket", "pasta"]:
        assert expected in text, expected


# ---------- importação v5 ----------

def test_v5_import():
    result = insomnia.from_v5(load("insomnia_v5.yaml"))
    (project,) = result.projects
    assert project.name == "Loja API v5"
    assert [r.name for r in project.requests] == [
        "Listar produtos", "Criar produto", "Admin / Usuários", "Admin / Ping sem auth",
    ], "ordenado por sortKey"
    reqs = by_name(project)
    assert reqs["Listar produtos"].url == "{{base_url}}/produtos?page=1"

    users = reqs["Admin / Usuários"]
    assert users.method == "DELETE"
    assert users.auth == AuthConfig(type="basic", username="root", password="{{senha}}"), "auth herdada da pasta"
    assert users.body_type == "text"
    assert ("Content-Type", "application/xml") in users.headers

    assert reqs["Admin / Ping sem auth"].auth.type == "none", "type: none não herda da pasta"
    assert reqs["Criar produto"].params == [("api_key", "{{key}}")], "apikey em queryParams"

    assert [e.name for e in project.environments] == ["Dev", "Prod"]
    assert env_vars(project, "Dev")["token"] == ("dev", False)
    assert env_vars(project, "Prod")["base_url"] == ("https://api.loja.com", False)
    assert result.warnings == ["Requisições WebSocket/gRPC não são suportadas e foram ignoradas: Socket"]


# ---------- exportação e ida e volta ----------

@pytest.fixture
def project():
    dev = Environment(name="dev", variables=[
        Variable("base", "https://api.test"),
        Variable("api.version", "v1"),
        Variable("token", "segredo", secret=True),
        Variable("off", "x", enabled=False),
    ])
    prod = Environment(name="prod", variables=[Variable("base", "https://prod.test")])
    return Project(
        name="Meu projeto",
        environments=[dev, prod],
        active_env_id=dev.id,
        requests=[
            SavedRequest(name="Listar", request=RequestSpec(
                url="{{base}}/{{api.version}}/itens?q=1", headers=[("Accept", "application/json")],
                auth=AuthConfig(type="bearer", token="{{token}}"))),
            SavedRequest(name="Criar", request=RequestSpec(
                method="POST", url="{{base}}/itens", body='{"n": {{n}}}', body_type="json",
                auth=AuthConfig(type="basic", username="u", password="{{senha}}"))),
            SavedRequest(name="Texto", request=RequestSpec(
                method="PUT", url="{{base}}/t", body="oi", body_type="text",
                headers=[("Content-Type", "text/csv")], params=[("a", "1")])),
        ],
    )


def assert_same_requests(original, imported):
    assert [r.name for r in imported.requests] == [r.name for r in original.requests]
    for a, b in zip(original.requests, imported.requests):
        ra, rb = a.request, b.request
        assert (rb.method, rb.url, rb.params, rb.headers, rb.body, rb.body_type, rb.auth) == \
               (ra.method, ra.url, ra.params, ra.headers, ra.body, ra.body_type, ra.auth), a.name


def test_v4_round_trip(project):
    exported = insomnia.to_v4(project)
    assert exported["_type"] == "export" and exported["__export_format"] == 4
    request = next(r for r in exported["resources"] if r["_type"] == "request")
    assert request["url"] == "{{ _.base }}/{{ _.api.version }}/itens?q=1"

    dev = next(r for r in exported["resources"] if r.get("name") == "dev")
    assert dev["data"] == {"base": "https://api.test", "api": {"version": "v1"}, "token": ""}

    (imported,) = insomnia.from_v4(exported).projects
    assert_same_requests(project, imported)
    assert env_vars(imported, "dev") == {"base": ("https://api.test", False), "api.version": ("v1", False), "token": ("", False)}
    assert [e.name for e in imported.environments] == ["dev", "prod"]


def test_v5_round_trip(project):
    text = insomnia.to_v5(project)
    doc = yaml.safe_load(text)
    assert doc["type"] == "collection.insomnia.rest/5.0"
    assert all(item["meta"]["id"].startswith("req_") for item in doc["collection"])
    assert [s["name"] for s in doc["environments"]["subEnvironments"]] == ["dev", "prod"]
    assert doc["environments"]["subEnvironments"][0]["data"]["token"] == "", "segredo vai vazio"
    assert "segredo" not in text

    (imported,) = insomnia.from_v5(insomnia.load_any(text)).projects
    assert_same_requests(project, imported)
    assert env_vars(imported, "prod") == {"base": ("https://prod.test", False)}


def test_unflatten_conflict_keeps_flat_key():
    assert insomnia.unflatten_env({"a": "1", "a.b": "2"}) == {"a": "1", "a.b": "2"}
    assert insomnia.unflatten_env({"x.y": "1", "x.z": "2"}) == {"x": {"y": "1", "z": "2"}}
