from __future__ import annotations

import re
from dataclasses import replace

from reqresp.models import AuthConfig, RequestSpec

VAR_RE = re.compile(r"\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}")
MAX_PASSES = 3


def resolve_text(text: str, variables: dict[str, str], missing: set[str] | None = None) -> str:
    """Substitui {{nome}} pelos valores; variáveis desconhecidas ficam como estão.

    Faz algumas passadas para valores que referenciam outras variáveis
    ({{base}} = "{{host}}/api"); ciclos simplesmente param no limite.
    """
    for _ in range(MAX_PASSES):
        new = VAR_RE.sub(lambda m: variables.get(m.group(1), m.group(0)), text)
        if new == text:
            break
        text = new
    if missing is not None:
        missing.update(name for name in VAR_RE.findall(text) if name not in variables)
    return text


def resolve(spec: RequestSpec, variables: dict[str, str]) -> tuple[RequestSpec, list[str]]:
    """Retorna uma cópia de `spec` com as variáveis resolvidas e as que faltaram."""
    missing: set[str] = set()

    def r(text: str) -> str:
        return resolve_text(text, variables, missing)

    resolved = replace(
        spec,
        url=r(spec.url),
        params=[(r(k), r(v)) for k, v in spec.params],
        headers=[(r(k), r(v)) for k, v in spec.headers],
        body=r(spec.body),
        auth=AuthConfig(
            type=spec.auth.type,
            token=r(spec.auth.token),
            username=r(spec.auth.username),
            password=r(spec.auth.password),
        ),
    )
    return resolved, sorted(missing)


def build_variables(*variable_lists) -> dict[str, str]:
    """Junta listas de `Variable` habilitadas; as listas seguintes sobrescrevem as anteriores."""
    result: dict[str, str] = {}
    for variables in variable_lists:
        for var in variables or []:
            if var.enabled and var.key:
                result[var.key] = var.value
    return result
