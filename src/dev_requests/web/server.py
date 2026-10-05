from __future__ import annotations

import threading
import webbrowser
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from dev_requests import insomnia
from dev_requests.history import DEFAULT_PATH, History
from dev_requests.http_client import send
from dev_requests.models import RequestSpec
from dev_requests.projects import Project, ProjectStore, Variable, migrate_legacy_dir
from dev_requests.variables import build_variables, resolve

STATIC_DIR = Path(__file__).parent / "static"
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
MAX_IMPORT_BYTES = 20 * 1024 * 1024
# Exigir este header força um preflight CORS, então outros sites abertos no
# navegador não conseguem usar o servidor local como proxy.
CLIENT_HEADER = "x-dev-requests"


def create_app(history_path: Path = DEFAULT_PATH) -> FastAPI:
    app = FastAPI(title="dev_requests", docs_url=None, redoc_url=None)
    history = History(history_path)
    history.load()
    store = ProjectStore(history_path.parent)
    store.ensure_default()

    def get_project(project_id: str) -> Project:
        try:
            return store.get(project_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="projeto não encontrado") from None

    @app.middleware("http")
    async def guard(request: Request, call_next):
        host = (request.headers.get("host") or "").rsplit(":", 1)[0]
        if host not in ALLOWED_HOSTS:
            return JSONResponse({"detail": "host não permitido"}, status_code=403)
        if request.url.path.startswith("/api/") and request.headers.get(CLIENT_HEADER) != "1":
            return JSONResponse({"detail": "cliente não permitido"}, status_code=403)
        response = await call_next(request)
        # Sem isso o navegador pode misturar HTML/JS antigos em cache com um servidor novo.
        if not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.post("/api/send")
    async def api_send(payload: dict):
        spec = RequestSpec.from_dict(payload.get("request") or {})
        environment = None
        if payload.get("project_id"):
            environment = get_project(payload["project_id"]).environment(payload.get("environment_id"))
        variables = build_variables(store.get_globals(), environment.variables if environment else [])
        resolved, unresolved = resolve(spec, variables)
        resp = await send(resolved)
        # O histórico guarda a versão com {{placeholders}}, para segredos não irem parar no disco.
        history.add(spec, resp)
        return {**asdict(resp), "resolved_url": resolved.url, "unresolved": unresolved}

    @app.get("/api/projects")
    async def api_list_projects():
        return store.list()

    @app.post("/api/projects")
    async def api_create_project(payload: dict):
        return store.create(str(payload.get("name", ""))).to_dict()

    @app.post("/api/projects/import")
    async def api_import_project(payload: dict):
        if not isinstance(payload.get("requests", []), list):
            raise HTTPException(status_code=400, detail="arquivo de projeto inválido")
        return store.import_(payload).to_dict()

    @app.get("/api/projects/{project_id}")
    async def api_get_project(project_id: str):
        return get_project(project_id).to_dict()

    @app.put("/api/projects/{project_id}")
    async def api_save_project(project_id: str, payload: dict):
        get_project(project_id)
        project = Project.from_dict({**payload, "id": project_id})
        return store.save(project).to_dict()

    @app.delete("/api/projects/{project_id}")
    async def api_delete_project(project_id: str):
        get_project(project_id)
        store.delete(project_id)
        store.ensure_default()
        return {"ok": True}

    @app.get("/api/projects/{project_id}/export")
    async def api_export_project(project_id: str, format: str = "dev_requests"):
        get_project(project_id)
        data = store.export(project_id)  # já sem os valores secretos
        if format == "dev_requests":
            return data
        project = Project.from_dict(data)
        if format == "insomnia-v4":
            return insomnia.to_v4(project)
        if format == "insomnia-v5":
            return Response(insomnia.to_v5(project), media_type="application/yaml; charset=utf-8")
        raise HTTPException(status_code=400, detail="formato de exportação desconhecido")

    @app.post("/api/import")
    async def api_import(request: Request):
        raw = await request.body()
        if len(raw) > MAX_IMPORT_BYTES:
            raise HTTPException(status_code=413, detail="arquivo grande demais (limite de 20 MB)")
        try:
            data = insomnia.load_any(raw.decode("utf-8-sig"))
            kind = insomnia.detect(data)
            if kind == "dev_requests":
                projects, warnings = [store.import_(data)], []
            else:
                result = insomnia.import_insomnia(data)
                projects = [store.import_(p.to_dict()) for p in result.projects]
                warnings = result.warnings
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="o arquivo não está em UTF-8") from None
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {
            "format": kind,
            "projects": [{"id": p.id, "name": p.name, "request_count": len(p.requests)} for p in projects],
            "warnings": warnings,
        }

    @app.get("/api/globals")
    async def api_get_globals():
        return [v.to_dict() for v in store.get_globals()]

    @app.put("/api/globals")
    async def api_save_globals(payload: list[dict]):
        return [v.to_dict() for v in store.save_globals([Variable.from_dict(v) for v in payload])]

    @app.get("/api/history")
    async def api_history():
        return [e.to_dict() for e in history.entries]

    @app.delete("/api/history")
    async def api_clear_history():
        history.clear()
        return {"ok": True}

    @app.get("/")
    async def index():
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def main() -> None:
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="dev_requests: cliente HTTP no navegador")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="não abrir o navegador")
    parser.add_argument(
        "--data-dir", type=Path, default=DEFAULT_PATH.parent,
        help="pasta onde ficam projetos, variáveis e histórico (padrão: ~/.dev_requests)",
    )
    args = parser.parse_args()

    if args.data_dir.expanduser() == DEFAULT_PATH.parent and migrate_legacy_dir():
        print("Dados copiados de ~/.reqresp para ~/.dev_requests (a pasta antiga foi mantida).")
    url = f"http://127.0.0.1:{args.port}"
    print(f"dev_requests rodando em {url}  (ctrl+c para sair)")
    if not args.no_browser:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    app = create_app(args.data_dir.expanduser() / "history.json")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
