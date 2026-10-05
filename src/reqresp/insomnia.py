"""Conversão entre projetos do reqresp e os formatos de exportação do Insomnia.

Suporta o formato atual (YAML v5, `type: collection.insomnia.rest/5.0`) e o
legado (JSON v4, `_type: export`). O Insomnia organiza requisições em pastas e
tem um "Base Environment" com sub-ambientes; o reqresp tem uma lista simples e
ambientes independentes, então a importação achata pastas (o nome vira
"Pasta / Requisição") e mescla a base em cada sub-ambiente.
"""

from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from dataclasses import dataclass, field
from urllib.parse import quote

import yaml

from reqresp.models import AuthConfig, RequestSpec
from reqresp.projects import Environment, Project, SavedRequest, Variable
from reqresp.variables import VAR_RE

INSOMNIA_VAR_RE = re.compile(r"\{\{\s*_\.([A-Za-z0-9_.\-]+)\s*\}\}")
TAG_RE = re.compile(r"\{%\s*([A-Za-z0-9_]+)")
JSON_MIME = "application/json"
FORM_MIME = "application/x-www-form-urlencoded"


# ---------- leitura e detecção ----------

def load_any(text: str):
    """Lê JSON ou YAML (todo JSON também é YAML válido)."""
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ValueError(f"o arquivo não é JSON nem YAML válido ({exc.__class__.__name__})") from exc


def detect(data) -> str:
    if isinstance(data, dict):
        if data.get("_type") == "export" and isinstance(data.get("resources"), list):
            return "insomnia-v4"
        kind = str(data.get("type", ""))
        if kind.startswith(("collection.insomnia.rest/5", "spec.insomnia.rest/5")):
            return "insomnia-v5"
        if kind.startswith("environment.insomnia.rest/5"):
            raise ValueError("este arquivo do Insomnia contém só um ambiente; exporte a coleção inteira")
        if isinstance(data.get("requests"), list) and isinstance(data.get("environments"), list):
            return "reqresp"
    raise ValueError("formato não reconhecido: esperava um export do reqresp ou do Insomnia (v4 ou v5)")


# ---------- avisos ----------

@dataclass
class Warnings:
    items: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))

    def add(self, message: str, detail: str = "") -> None:
        self.items[message].append(detail)

    def render(self) -> list[str]:
        out = []
        for message, details in self.items.items():
            names = [d for d in dict.fromkeys(details) if d]
            suffix = ""
            if names:
                shown = ", ".join(names[:5]) + (f" e mais {len(names) - 5}" if len(names) > 5 else "")
                suffix = f": {shown}"
            out.append(f"{message}{suffix}")
        return out


@dataclass
class ImportResult:
    projects: list[Project]
    warnings: list[str]


# ---------- conversão de templates ----------

def from_insomnia_template(text, warnings: Warnings | None = None) -> str:
    if not isinstance(text, str):
        return "" if text is None else str(text)
    text = INSOMNIA_VAR_RE.sub(r"{{\1}}", text)
    text = VAR_RE.sub(r"{{\1}}", text)
    if warnings is not None:
        for tag in TAG_RE.findall(text):
            warnings.add("Tags do Insomnia mantidas como texto (o reqresp não as executa)", f"{{% {tag} %}}")
    return text


def to_insomnia_template(text: str) -> str:
    return VAR_RE.sub(r"{{ _.\1 }}", text or "")


def _scalar(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def flatten_env(data, prefix: str = "") -> dict[str, str]:
    """{"api": {"url": "x"}} -> {"api.url": "x"}"""
    out: dict[str, str] = {}
    if not isinstance(data, dict):
        return out
    for key, value in data.items():
        name = f"{prefix}{key}"
        if isinstance(value, dict) and value:
            out.update(flatten_env(value, f"{name}."))
        else:
            out[name] = _scalar(value)
    return out


def unflatten_env(values: dict[str, str]) -> dict:
    """Inverso de flatten_env; em caso de conflito ("a" e "a.b"), mantém a chave plana."""
    out: dict = {}
    for key, value in values.items():
        parts = key.split(".")
        node = out
        ok = all(p for p in parts)
        if ok:
            for part in parts[:-1]:
                if part not in node:
                    node[part] = {}
                if not isinstance(node[part], dict):
                    ok = False
                    break
                node = node[part]
        if ok and not isinstance(node.get(parts[-1]), dict):
            node[parts[-1]] = value
        else:
            out[key] = value
    return out


# ---------- importação: requisições ----------

def _pairs(items, warnings: Warnings) -> list[tuple[str, str]]:
    pairs = []
    for item in items or []:
        if not isinstance(item, dict) or item.get("disabled") or not item.get("name"):
            continue
        pairs.append((from_insomnia_template(item["name"], warnings),
                      from_insomnia_template(item.get("value", ""), warnings)))
    return pairs


def _has_header(headers, name: str) -> bool:
    return any(k.lower() == name.lower() for k, _ in headers)


def _convert_auth(auth: dict, headers: list, params: list, req_name: str, warnings: Warnings) -> AuthConfig:
    t = lambda v: from_insomnia_template(v, warnings)  # noqa: E731
    kind = auth.get("type")
    if not kind or kind == "none" or auth.get("disabled"):
        return AuthConfig()
    if kind == "bearer":
        prefix = (auth.get("prefix") or "").strip()
        if prefix and prefix.lower() != "bearer":
            headers.append(("Authorization", f"{t(prefix)} {t(auth.get('token', ''))}"))
            return AuthConfig()
        return AuthConfig(type="bearer", token=t(auth.get("token", "")))
    if kind == "basic":
        return AuthConfig(type="basic", username=t(auth.get("username", "")), password=t(auth.get("password", "")))
    if kind == "apikey":
        key, value = t(auth.get("key", "")), t(auth.get("value", ""))
        where = auth.get("addTo") or "header"
        if key:
            if where == "queryParams":
                params.append((key, value))
            elif where == "cookie":
                headers.append(("Cookie", f"{key}={value}"))
            else:
                headers.append((key, value))
        return AuthConfig()
    warnings.add(f"Autenticação do tipo \"{kind}\" não é suportada e foi removida", req_name)
    return AuthConfig()


def _convert_body(body: dict, headers: list, req_name: str, warnings: Warnings) -> tuple[str, str]:
    t = lambda v: from_insomnia_template(v, warnings)  # noqa: E731
    mime = (body.get("mimeType") or "").lower()
    text = body.get("text") or ""

    if mime == FORM_MIME:
        pairs = _pairs(body.get("params"), warnings)
        encoded = "&".join(f"{quote(k, safe='{}')}={quote(v, safe='{}')}" for k, v in pairs)
        if not _has_header(headers, "Content-Type"):
            headers.append(("Content-Type", FORM_MIME))
        warnings.add("Bodies form-urlencoded foram convertidos para texto", req_name)
        return encoded, "text"
    if mime.startswith("multipart/") or body.get("fileName") or (body.get("params") and not text):
        warnings.add("Bodies multipart/arquivo não são suportados e foram removidos", req_name)
        return "", "none"
    if not text:
        return "", "none"
    if mime in (JSON_MIME, "application/graphql") or mime.endswith("+json"):
        return t(text), "json"
    if mime and not _has_header(headers, "Content-Type"):
        headers.append(("Content-Type", body.get("mimeType")))
    return t(text), "text"


def _convert_request(raw: dict, path: list[str], inherited_headers, inherited_auth, warnings: Warnings) -> SavedRequest:
    url = raw.get("url") or ""
    name = " / ".join([*path, raw.get("name") or url or "Requisição"])
    headers = list(inherited_headers)
    own = _pairs(raw.get("headers"), warnings)
    # Header de mesmo nome na requisição substitui o herdado da pasta.
    own_names = {k.lower() for k, _ in own}
    headers = [(k, v) for k, v in headers if k.lower() not in own_names] + own
    params = _pairs(raw.get("parameters"), warnings)

    body, body_type = _convert_body(raw.get("body") or {}, headers, name, warnings)
    if body_type == "json":
        # O reqresp define Content-Type: application/json sozinho para body JSON.
        headers = [(k, v) for k, v in headers if not (k.lower() == "content-type" and v.lower().startswith(JSON_MIME))]

    auth_raw = raw.get("authentication") or {}
    if not auth_raw and inherited_auth:  # {} = "herdar da pasta"
        auth_raw = inherited_auth
    auth = _convert_auth(auth_raw, headers, params, name, warnings)

    spec = RequestSpec(
        method=(raw.get("method") or "GET").upper(),
        url=from_insomnia_template(url, warnings),
        params=params,
        headers=headers,
        body=body,
        body_type=body_type,
        auth=auth,
    )
    return SavedRequest(name=name, request=spec)


def _folder_context(group: dict, path, headers, auth, folder_vars, warnings: Warnings):
    name = group.get("name") or "Pasta"
    new_headers = list(headers)
    for k, v in _pairs(group.get("headers"), warnings):
        new_headers = [(hk, hv) for hk, hv in new_headers if hk.lower() != k.lower()] + [(k, v)]
    new_auth = group.get("authentication") or auth
    env = flatten_env(group.get("environment"))
    if env:
        warnings.add("Variáveis de pasta foram adicionadas a todos os ambientes", name)
        for k, v in env.items():
            folder_vars.setdefault(k, from_insomnia_template(v, warnings))
    return [*path, name], new_headers, new_auth


# ---------- importação: ambientes ----------

def _build_environments(base: dict | None, subs: list[dict], folder_vars: dict, warnings: Warnings) -> list[Environment]:
    t = lambda v: from_insomnia_template(v, warnings)  # noqa: E731
    base_vars = {k: t(v) for k, v in flatten_env((base or {}).get("data")).items()}
    envs = []
    for sub in subs:
        own = {k: t(v) for k, v in flatten_env(sub.get("data")).items()}
        values = {**base_vars, **own}
        # Ambiente "privado" no Insomnia: as variáveis dele viram secretas aqui.
        private = bool(sub.get("isPrivate") or (sub.get("meta") or {}).get("isPrivate"))
        envs.append(Environment(
            name=sub.get("name") or "Ambiente",
            variables=[Variable(k, v, secret=private and k in own) for k, v in values.items()],
        ))
    if not envs and (base_vars or folder_vars):
        envs.append(Environment(name="Base", variables=[Variable(k, v) for k, v in base_vars.items()]))
    for env in envs:
        existing = {v.key for v in env.variables}
        env.variables += [Variable(k, v) for k, v in folder_vars.items() if k not in existing]
    return envs


def _finish(name: str, requests, envs) -> Project:
    return Project(name=name or "Importado do Insomnia", requests=requests, environments=envs,
                   active_env_id=envs[0].id if envs else None)


# ---------- importação: v4 ----------

def _sort_key(resource: dict, index: int):
    key = resource.get("metaSortKey")
    return (key if isinstance(key, (int, float)) else 0, index)


def from_v4(data: dict) -> ImportResult:
    warnings = Warnings()
    resources = [r for r in data.get("resources", []) if isinstance(r, dict)]
    by_parent: dict = defaultdict(list)
    for i, r in enumerate(resources):
        by_parent[r.get("parentId")].append((i, r))
    ids = {r.get("_id") for r in resources}

    workspaces = [r for r in resources if r.get("_type") == "workspace"]
    if not workspaces:
        # Export sem workspace: tudo que não tem pai conhecido vira um projeto.
        orphans = {r.get("parentId") for r in resources if r.get("parentId") not in ids}
        workspaces = [{"_id": pid, "name": "Importado do Insomnia"} for pid in orphans]

    projects = []
    for ws in workspaces:
        requests: list[SavedRequest] = []
        folder_vars: dict[str, str] = {}

        def walk(parent_id, path, headers, auth):
            children = sorted(by_parent.get(parent_id, []), key=lambda p: _sort_key(p[1], p[0]))
            for _, r in children:
                kind = r.get("_type")
                if kind == "request_group":
                    sub_path, sub_headers, sub_auth = _folder_context(r, path, headers, auth, folder_vars, warnings)
                    walk(r.get("_id"), sub_path, sub_headers, sub_auth)
                elif kind == "request":
                    requests.append(_convert_request(r, path, headers, auth, warnings))
                elif kind in ("websocket_request", "grpc_request"):
                    warnings.add("Requisições WebSocket/gRPC não são suportadas e foram ignoradas", r.get("name", ""))

        walk(ws.get("_id"), [], [], None)

        bases = [r for _, r in by_parent.get(ws.get("_id"), []) if r.get("_type") == "environment"]
        base = bases[0] if bases else None
        subs = []
        if base:
            subs = [r for i, r in sorted(by_parent.get(base.get("_id"), []), key=lambda p: _sort_key(p[1], p[0]))
                    if r.get("_type") == "environment"]
        envs = _build_environments(base, subs, folder_vars, warnings)
        projects.append(_finish(ws.get("name"), requests, envs))

    if not any(p.requests or p.environments for p in projects):
        raise ValueError("o arquivo do Insomnia não tem requisições nem ambientes")
    return ImportResult(projects, warnings.render())


# ---------- importação: v5 ----------

def _ordered(items: list) -> list:
    """Ordena por meta.sortKey; itens sem sortKey vão para o fim, na ordem do arquivo."""
    indexed = [(i, it) for i, it in enumerate(items or []) if isinstance(it, dict)]

    def key(pair):
        sort_key = (pair[1].get("meta") or {}).get("sortKey")
        return (0, sort_key, pair[0]) if isinstance(sort_key, (int, float)) else (1, 0, pair[0])

    return [it for _, it in sorted(indexed, key=key)]


def from_v5(data: dict) -> ImportResult:
    warnings = Warnings()
    requests: list[SavedRequest] = []
    folder_vars: dict[str, str] = {}

    def walk(items, path, headers, auth):
        for item in _ordered(items):
            if "children" in item and "method" not in item:
                sub_path, sub_headers, sub_auth = _folder_context(item, path, headers, auth, folder_vars, warnings)
                walk(item.get("children"), sub_path, sub_headers, sub_auth)
            elif item.get("method"):
                requests.append(_convert_request(item, path, headers, auth, warnings))
            else:
                warnings.add("Requisições WebSocket/gRPC não são suportadas e foram ignoradas", item.get("name", ""))

    walk(data.get("collection"), [], [], None)
    base = data.get("environments") if isinstance(data.get("environments"), dict) else None
    subs = [s for s in (base or {}).get("subEnvironments") or [] if isinstance(s, dict)]
    envs = _build_environments(base, _ordered(subs), folder_vars, warnings)
    project = _finish(data.get("name"), requests, envs)
    if not project.requests and not project.environments:
        raise ValueError("o arquivo do Insomnia não tem requisições nem ambientes")
    return ImportResult([project], warnings.render())


def import_insomnia(data) -> ImportResult:
    kind = detect(data)
    if kind == "insomnia-v4":
        return from_v4(data)
    if kind == "insomnia-v5":
        return from_v5(data)
    raise ValueError("não é um arquivo do Insomnia")


# ---------- exportação ----------

def _env_data(env: Environment) -> dict:
    return unflatten_env({v.key: to_insomnia_template("" if v.secret else v.value)
                          for v in env.variables if v.enabled and v.key})


def _export_body(spec: RequestSpec) -> dict:
    if spec.body_type == "json":
        return {"mimeType": JSON_MIME, "text": to_insomnia_template(spec.body)}
    if spec.body_type == "text":
        mime = next((v for k, v in spec.headers if k.lower() == "content-type"), "text/plain")
        return {"mimeType": mime, "text": to_insomnia_template(spec.body)}
    return {}


def _export_headers(spec: RequestSpec) -> list[dict]:
    headers = [{"name": to_insomnia_template(k), "value": to_insomnia_template(v)} for k, v in spec.headers]
    if spec.body_type == "json" and not _has_header(spec.headers, "Content-Type"):
        headers.append({"name": "Content-Type", "value": JSON_MIME})
    return headers


def _export_auth(auth: AuthConfig) -> dict:
    if auth.type == "bearer":
        return {"type": "bearer", "token": to_insomnia_template(auth.token), "prefix": "", "disabled": False}
    if auth.type == "basic":
        return {"type": "basic", "username": to_insomnia_template(auth.username),
                "password": to_insomnia_template(auth.password), "disabled": False, "useISO88591": False}
    return {}


def to_v4(project: Project) -> dict:
    now = int(time.time() * 1000)
    wrk = f"wrk_{project.id}"
    base_id = f"env_{project.id}_base"
    stamp = {"created": now, "modified": now}
    resources = [
        {"_id": wrk, "_type": "workspace", "parentId": None, "name": project.name,
         "description": "", "scope": "collection", **stamp},
        {"_id": base_id, "_type": "environment", "parentId": wrk, "name": "Base Environment",
         "data": {}, "dataPropertyOrder": None, "color": None, "isPrivate": False, "metaSortKey": now, **stamp},
    ]
    for i, env in enumerate(project.environments):
        data = _env_data(env)
        resources.append({
            "_id": f"env_{env.id}", "_type": "environment", "parentId": base_id, "name": env.name,
            "data": data, "dataPropertyOrder": {"&": list(data)}, "color": None, "isPrivate": False,
            "metaSortKey": i, **stamp,
        })
    total = len(project.requests)
    for i, saved in enumerate(project.requests):
        spec = saved.request
        resources.append({
            "_id": f"req_{saved.id}", "_type": "request", "parentId": wrk, "name": saved.name,
            "description": "", "method": spec.method, "url": to_insomnia_template(spec.url),
            "body": _export_body(spec),
            "parameters": [{"name": to_insomnia_template(k), "value": to_insomnia_template(v), "disabled": False}
                           for k, v in spec.params],
            "headers": _export_headers(spec),
            "authentication": _export_auth(spec.auth),
            "metaSortKey": -(total - i),
            "isPrivate": False, "settingStoreCookies": True, "settingSendCookies": True,
            "settingDisableRenderRequestBody": False, "settingEncodeUrl": True,
            "settingRebuildPath": True, "settingFollowRedirects": "global", **stamp,
        })
    return {
        "_type": "export",
        "__export_format": 4,
        "__export_date": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "__export_source": "reqresp",
        "resources": resources,
    }


def to_v5(project: Project) -> str:
    now = int(time.time() * 1000)
    meta = lambda id_, **extra: {"id": id_, "created": now, "modified": now, **extra}  # noqa: E731
    total = len(project.requests)
    collection = []
    for i, saved in enumerate(project.requests):
        spec = saved.request
        item = {
            "url": to_insomnia_template(spec.url),
            "name": saved.name,
            "meta": meta(f"req_{saved.id}", isPrivate=False, description="", sortKey=-(total - i)),
            "method": spec.method,
        }
        if body := _export_body(spec):
            item["body"] = body
        if spec.params:
            item["parameters"] = [{"name": to_insomnia_template(k), "value": to_insomnia_template(v), "disabled": False}
                                  for k, v in spec.params]
        if headers := _export_headers(spec):
            item["headers"] = headers
        if auth := _export_auth(spec.auth):
            item["authentication"] = auth
        item["settings"] = {
            "renderRequestBody": True, "encodeUrl": True, "followRedirects": "global",
            "cookies": {"send": True, "store": True}, "rebuildPath": True,
        }
        collection.append(item)

    doc = {
        "type": "collection.insomnia.rest/5.0",
        "name": project.name,
        "meta": meta(f"wrk_{project.id}", description=""),
        "collection": collection,
        "cookieJar": {"name": "Default Jar", "meta": meta(f"jar_{project.id}")},
        "environments": {
            "name": "Base Environment",
            "meta": meta(f"env_{project.id}_base", isPrivate=False),
            "data": {},
            "subEnvironments": [
                {"name": env.name, "meta": meta(f"env_{env.id}", isPrivate=False, sortKey=i), "data": _env_data(env)}
                for i, env in enumerate(project.environments)
            ],
        },
    }
    return yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=1000)
