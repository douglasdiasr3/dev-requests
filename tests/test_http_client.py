import base64
import json

import httpx
import respx

from reqresp.http_client import send
from reqresp.models import AuthConfig, RequestSpec


@respx.mock
async def test_get_with_params_and_headers():
    route = respx.get("https://api.test/users").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    resp = await send(
        RequestSpec(url="https://api.test/users", params=[("page", "2")], headers=[("X-A", "1")])
    )
    assert resp.error is None
    assert resp.status == 200
    assert json.loads(resp.body_text) == {"ok": True}
    req = route.calls.last.request
    assert req.url.params["page"] == "2"
    assert req.headers["X-A"] == "1"


@respx.mock
async def test_post_json_sets_content_type():
    route = respx.post("https://api.test/items").mock(return_value=httpx.Response(201))
    resp = await send(
        RequestSpec(method="POST", url="https://api.test/items", body='{"a": 1}', body_type="json")
    )
    assert resp.status == 201
    req = route.calls.last.request
    assert req.headers["Content-Type"] == "application/json"
    assert json.loads(req.content) == {"a": 1}


async def test_invalid_json_body_returns_error():
    resp = await send(RequestSpec(method="POST", url="https://api.test", body="{x", body_type="json"))
    assert resp.error and "JSON inválido" in resp.error


@respx.mock
async def test_bearer_auth():
    route = respx.get("https://api.test/me").mock(return_value=httpx.Response(200))
    await send(RequestSpec(url="https://api.test/me", auth=AuthConfig(type="bearer", token="abc")))
    assert route.calls.last.request.headers["Authorization"] == "Bearer abc"


@respx.mock
async def test_basic_auth():
    route = respx.get("https://api.test/me").mock(return_value=httpx.Response(200))
    await send(
        RequestSpec(url="https://api.test/me", auth=AuthConfig(type="basic", username="u", password="p"))
    )
    expected = "Basic " + base64.b64encode(b"u:p").decode()
    assert route.calls.last.request.headers["Authorization"] == expected


@respx.mock
async def test_timeout_returns_error():
    respx.get("https://api.test/slow").mock(side_effect=httpx.ReadTimeout("slow"))
    resp = await send(RequestSpec(url="https://api.test/slow"))
    assert resp.error and "Timeout" in resp.error


@respx.mock
async def test_connection_error_returns_error():
    respx.get("https://api.test/down").mock(side_effect=httpx.ConnectError("refused"))
    resp = await send(RequestSpec(url="https://api.test/down"))
    assert resp.error and "ConnectError" in resp.error


async def test_empty_url():
    resp = await send(RequestSpec(url="  "))
    assert resp.error == "URL vazia"


@respx.mock
async def test_url_without_scheme_defaults_to_http():
    route = respx.get("http://localhost:8000/x").mock(return_value=httpx.Response(204))
    resp = await send(RequestSpec(url="localhost:8000/x"))
    assert resp.status == 204
    assert route.called


@respx.mock
async def test_query_in_url_is_kept():
    route = respx.get("https://api.test/search").mock(return_value=httpx.Response(200))
    await send(RequestSpec(url="https://api.test/search?q=ana&page=2"))
    assert dict(route.calls.last.request.url.params) == {"q": "ana", "page": "2"}
