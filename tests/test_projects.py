import json

import pytest

from reqresp.models import RequestSpec
from reqresp.projects import Environment, Project, ProjectStore, SavedRequest, Variable


@pytest.fixture
def store(tmp_path):
    return ProjectStore(tmp_path)


def test_default_project_created_once(store):
    store.ensure_default()
    store.ensure_default()
    projects = store.list()
    assert [p["name"] for p in projects] == ["Meu projeto"]
    project = store.get(projects[0]["id"])
    assert [e.name for e in project.environments] == ["dev"]
    assert project.active_env_id == project.environments[0].id


def test_crud_roundtrip(store):
    project = store.create("API")
    project.requests.append(SavedRequest(name="Lista", request=RequestSpec(method="POST", url="{{base}}/x")))
    store.save(project)

    loaded = store.get(project.id)
    assert loaded.requests[0].name == "Lista"
    assert loaded.requests[0].request.url == "{{base}}/x"
    assert store.list() == [{"id": project.id, "name": "API", "request_count": 1}]

    store.delete(project.id)
    with pytest.raises(KeyError):
        store.get(project.id)


def test_rejects_invalid_ids(store):
    for bad in ["../etc", "ABC", "", "a/b"]:
        with pytest.raises(KeyError):
            store.get(bad)


def test_corrupt_file_is_ignored(store, tmp_path):
    store.create("Bom")
    (tmp_path / "projects" / "abc.json").write_text("{quebrado")
    assert [p["name"] for p in store.list()] == ["Bom"]


def test_export_strips_secrets_and_import_gets_new_ids(store):
    env = Environment(name="prod", variables=[Variable("token", "s3cr3t", secret=True), Variable("base", "https://x")])
    project = store.save(Project(name="API", environments=[env], active_env_id=env.id,
                                 requests=[SavedRequest(name="r")]))

    exported = store.export(project.id)
    values = {v["key"]: v["value"] for v in exported["environments"][0]["variables"]}
    assert values == {"token": "", "base": "https://x"}
    assert store.get(project.id).environments[0].variables[0].value == "s3cr3t", "export não altera o original"

    imported = store.import_(json.loads(json.dumps(exported)))
    assert imported.id != project.id
    assert imported.name == "API (importado)"
    assert imported.environments[0].id != env.id
    assert imported.active_env_id == imported.environments[0].id
    assert imported.requests[0].id != project.requests[0].id
    assert len(store.list()) == 2


def test_globals_roundtrip(store):
    assert store.get_globals() == []
    store.save_globals([Variable("nome", "ana")])
    assert store.get_globals() == [Variable("nome", "ana")]
