from reqresp.models import AuthConfig, RequestSpec
from reqresp.projects import Variable
from reqresp.variables import build_variables, resolve, resolve_text


def test_resolves_all_fields():
    spec = RequestSpec(
        url="{{base}}/users?q={{ nome }}",
        params=[("{{k}}", "{{v}}")],
        headers=[("X-Env", "{{env}}")],
        body='{"nome": "{{nome}}"}',
        body_type="json",
        auth=AuthConfig(type="basic", token="{{t}}", username="{{u}}", password="{{p}}"),
    )
    variables = {"base": "https://api.test", "nome": "ana", "k": "a", "v": "1", "env": "dev", "t": "T", "u": "U", "p": "P"}
    resolved, missing = resolve(spec, variables)
    assert missing == []
    assert resolved.url == "https://api.test/users?q=ana"
    assert resolved.params == [("a", "1")]
    assert resolved.headers == [("X-Env", "dev")]
    assert resolved.body == '{"nome": "ana"}'
    assert (resolved.auth.token, resolved.auth.username, resolved.auth.password) == ("T", "U", "P")
    assert spec.url == "{{base}}/users?q={{ nome }}", "o original não pode ser alterado"


def test_missing_variables_are_kept_and_reported():
    resolved, missing = resolve(RequestSpec(url="{{base}}/{{x}}/{{y}}"), {"base": "h"})
    assert resolved.url == "h/{{x}}/{{y}}"
    assert missing == ["x", "y"]


def test_nested_and_cycles():
    assert resolve_text("{{api}}/v1", {"api": "{{host}}/api", "host": "https://h"}) == "https://h/api/v1"
    missing = set()
    out = resolve_text("{{a}}", {"a": "{{b}}", "b": "{{a}}"}, missing)
    assert out in ("{{a}}", "{{b}}")


def test_build_variables_precedence_and_disabled():
    globals_ = [Variable("base", "global"), Variable("nome", "ana"), Variable("off", "x", enabled=False)]
    env = [Variable("base", "env"), Variable("", "sem-chave")]
    assert build_variables(globals_, env) == {"base": "env", "nome": "ana"}
