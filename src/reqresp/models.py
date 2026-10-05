from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

BodyType = Literal["none", "json", "text"]
AuthType = Literal["none", "bearer", "basic"]


@dataclass
class AuthConfig:
    type: AuthType = "none"
    token: str = ""
    username: str = ""
    password: str = ""


@dataclass
class RequestSpec:
    method: str = "GET"
    url: str = ""
    params: list[tuple[str, str]] = field(default_factory=list)
    headers: list[tuple[str, str]] = field(default_factory=list)
    body: str = ""
    body_type: BodyType = "none"
    auth: AuthConfig = field(default_factory=AuthConfig)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> RequestSpec:
        return cls(
            method=data.get("method", "GET"),
            url=data.get("url", ""),
            params=[tuple(p) for p in data.get("params", [])],
            headers=[tuple(h) for h in data.get("headers", [])],
            body=data.get("body", ""),
            body_type=data.get("body_type", "none"),
            auth=AuthConfig(**data.get("auth", {})),
        )


@dataclass
class ResponseData:
    status: int = 0
    reason: str = ""
    headers: list[tuple[str, str]] = field(default_factory=list)
    body_text: str = ""
    elapsed_ms: float = 0.0
    size_bytes: int = 0
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None
