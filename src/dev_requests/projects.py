from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from dev_requests.models import RequestSpec

DEFAULT_BASE_DIR = Path.home() / ".dev_requests"
LEGACY_BASE_DIR = Path.home() / ".reqresp"  # pasta de quando o app se chamava reqresp
ID_RE = re.compile(r"^[0-9a-f]{1,32}$")


def migrate_legacy_dir(base: Path = DEFAULT_BASE_DIR, legacy: Path = LEGACY_BASE_DIR) -> bool:
    """Na primeira execução, copia os dados da pasta antiga. A antiga fica como backup."""
    if base.exists() or not legacy.is_dir():
        return False
    shutil.copytree(legacy, base)
    return True


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def valid_id(value: str) -> bool:
    return bool(ID_RE.match(value or ""))


@dataclass
class Variable:
    key: str = ""
    value: str = ""
    secret: bool = False
    enabled: bool = True

    def to_dict(self) -> dict:
        return {"key": self.key, "value": self.value, "secret": self.secret, "enabled": self.enabled}

    @classmethod
    def from_dict(cls, data: dict) -> Variable:
        return cls(
            key=str(data.get("key", "")),
            value=str(data.get("value", "")),
            secret=bool(data.get("secret", False)),
            enabled=bool(data.get("enabled", True)),
        )


def _variables_from(data) -> list[Variable]:
    return [Variable.from_dict(v) for v in data or [] if isinstance(v, dict)]


@dataclass
class Environment:
    id: str = field(default_factory=new_id)
    name: str = "Novo ambiente"
    variables: list[Variable] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "variables": [v.to_dict() for v in self.variables]}

    @classmethod
    def from_dict(cls, data: dict) -> Environment:
        return cls(
            id=data.get("id") if valid_id(data.get("id", "")) else new_id(),
            name=str(data.get("name", "Ambiente")),
            variables=_variables_from(data.get("variables")),
        )


@dataclass
class SavedRequest:
    id: str = field(default_factory=new_id)
    name: str = "Nova requisição"
    request: RequestSpec = field(default_factory=RequestSpec)

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "request": self.request.to_dict()}

    @classmethod
    def from_dict(cls, data: dict) -> SavedRequest:
        return cls(
            id=data.get("id") if valid_id(data.get("id", "")) else new_id(),
            name=str(data.get("name", "Requisição")),
            request=RequestSpec.from_dict(data.get("request") or {}),
        )


@dataclass
class Project:
    id: str = field(default_factory=new_id)
    name: str = "Novo projeto"
    requests: list[SavedRequest] = field(default_factory=list)
    environments: list[Environment] = field(default_factory=list)
    active_env_id: str | None = None

    def environment(self, env_id: str | None) -> Environment | None:
        return next((e for e in self.environments if e.id == env_id), None)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "requests": [r.to_dict() for r in self.requests],
            "environments": [e.to_dict() for e in self.environments],
            "active_env_id": self.active_env_id,
        }

    @classmethod
    def from_dict(cls, data: dict) -> Project:
        project = cls(
            id=data.get("id") if valid_id(data.get("id", "")) else new_id(),
            name=str(data.get("name", "Projeto")),
            requests=[SavedRequest.from_dict(r) for r in data.get("requests") or [] if isinstance(r, dict)],
            environments=[Environment.from_dict(e) for e in data.get("environments") or [] if isinstance(e, dict)],
            active_env_id=data.get("active_env_id"),
        )
        if not project.environment(project.active_env_id):
            project.active_env_id = None
        return project


def _write_json(path: Path, data) -> None:
    """Grava de forma atômica: um crash no meio nunca deixa o arquivo pela metade."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    os.replace(tmp, path)


class ProjectStore:
    def __init__(self, base_dir: Path = DEFAULT_BASE_DIR):
        self.dir = base_dir / "projects"
        self.globals_path = base_dir / "globals.json"

    def _path(self, project_id: str) -> Path:
        if not valid_id(project_id):
            raise KeyError(project_id)
        return self.dir / f"{project_id}.json"

    def ensure_default(self) -> None:
        if not self.list():
            dev = Environment(name="dev")
            self.save(Project(name="Meu projeto", environments=[dev], active_env_id=dev.id))

    def list(self) -> list[dict]:
        summaries = []
        for path in sorted(self.dir.glob("*.json")) if self.dir.exists() else []:
            try:
                project = Project.from_dict(json.loads(path.read_text()))
            except (json.JSONDecodeError, OSError, TypeError, AttributeError):
                continue
            summaries.append({"id": project.id, "name": project.name, "request_count": len(project.requests)})
        return sorted(summaries, key=lambda p: p["name"].lower())

    def get(self, project_id: str) -> Project:
        path = self._path(project_id)
        try:
            return Project.from_dict(json.loads(path.read_text()))
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            raise KeyError(project_id) from exc

    def create(self, name: str) -> Project:
        dev = Environment(name="dev")
        project = Project(name=name.strip() or "Novo projeto", environments=[dev], active_env_id=dev.id)
        self.save(project)
        return project

    def save(self, project: Project) -> Project:
        _write_json(self._path(project.id), project.to_dict())
        return project

    def delete(self, project_id: str) -> None:
        try:
            self._path(project_id).unlink()
        except FileNotFoundError as exc:
            raise KeyError(project_id) from exc

    def get_globals(self) -> list[Variable]:
        try:
            return _variables_from(json.loads(self.globals_path.read_text()))
        except (FileNotFoundError, json.JSONDecodeError):
            return []

    def save_globals(self, variables: list[Variable]) -> list[Variable]:
        _write_json(self.globals_path, [v.to_dict() for v in variables])
        return variables

    def export(self, project_id: str) -> dict:
        data = self.get(project_id).to_dict()
        for env in data["environments"]:
            for var in env["variables"]:
                if var["secret"]:
                    var["value"] = ""
        data["dev_requests_export"] = 1
        return data

    def import_(self, data: dict) -> Project:
        project = Project.from_dict(data)
        # Ids novos, para importar o mesmo arquivo duas vezes não sobrescrever nada.
        env_ids = {}
        project.id = new_id()
        for env in project.environments:
            env_ids[env.id] = env.id = new_id()
        for req in project.requests:
            req.id = new_id()
        project.active_env_id = env_ids.get(project.active_env_id)
        if any(p["name"] == project.name for p in self.list()):
            project.name = f"{project.name} (importado)"
        return self.save(project)
