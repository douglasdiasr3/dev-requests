from __future__ import annotations

import json
import time

import httpx

from reqresp.models import RequestSpec, ResponseData

TIMEOUT = 30.0


def _build_kwargs(spec: RequestSpec) -> dict:
    headers = {k: v for k, v in spec.headers if k}
    params = [(k, v) for k, v in spec.params if k]
    kwargs: dict = {}
    if params:
        # Passar params vazio faria o httpx descartar a query que já está na URL.
        kwargs["params"] = params

    auth = spec.auth
    if auth.type == "bearer" and auth.token:
        headers["Authorization"] = f"Bearer {auth.token}"
    elif auth.type == "basic":
        kwargs["auth"] = httpx.BasicAuth(auth.username, auth.password)

    if spec.body_type == "json" and spec.body.strip():
        # Valida antes de enviar para dar um erro claro na interface.
        json.loads(spec.body)
        kwargs["content"] = spec.body.encode()
        if not any(k.lower() == "content-type" for k in headers):
            headers["Content-Type"] = "application/json"
    elif spec.body_type == "text" and spec.body:
        kwargs["content"] = spec.body.encode()

    kwargs["headers"] = headers
    return kwargs


async def send(spec: RequestSpec) -> ResponseData:
    url = spec.url.strip()
    if not url:
        return ResponseData(error="URL vazia")
    if "://" not in url:
        url = "http://" + url

    try:
        kwargs = _build_kwargs(spec)
    except json.JSONDecodeError as exc:
        return ResponseData(error=f"Body JSON inválido: {exc}")

    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
            resp = await client.request(spec.method, url, **kwargs)
    except httpx.TimeoutException:
        return ResponseData(error=f"Timeout após {TIMEOUT:.0f}s")
    except httpx.HTTPError as exc:
        return ResponseData(error=f"{type(exc).__name__}: {exc}")
    elapsed = (time.perf_counter() - start) * 1000

    return ResponseData(
        status=resp.status_code,
        reason=resp.reason_phrase,
        headers=list(resp.headers.items()),
        body_text=resp.text,
        elapsed_ms=elapsed,
        size_bytes=len(resp.content),
    )
