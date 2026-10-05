from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from reqresp.models import RequestSpec, ResponseData

DEFAULT_PATH = Path.home() / ".reqresp" / "history.json"
MAX_ENTRIES = 50


@dataclass
class HistoryEntry:
    request: RequestSpec
    status: int
    elapsed_ms: float
    error: str | None
    timestamp: float

    def to_dict(self) -> dict:
        return {
            "request": self.request.to_dict(),
            "status": self.status,
            "elapsed_ms": self.elapsed_ms,
            "error": self.error,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data: dict) -> HistoryEntry:
        return cls(
            request=RequestSpec.from_dict(data["request"]),
            status=data.get("status", 0),
            elapsed_ms=data.get("elapsed_ms", 0.0),
            error=data.get("error"),
            timestamp=data.get("timestamp", 0.0),
        )


class History:
    """Histórico das últimas requisições, mais recente primeiro."""

    def __init__(self, path: Path = DEFAULT_PATH, max_entries: int = MAX_ENTRIES):
        self.path = path
        self.max_entries = max_entries
        self.entries: list[HistoryEntry] = []

    def load(self) -> list[HistoryEntry]:
        try:
            raw = json.loads(self.path.read_text())
            self.entries = [HistoryEntry.from_dict(d) for d in raw][: self.max_entries]
        except (FileNotFoundError, json.JSONDecodeError, KeyError, TypeError):
            self.entries = []
        return self.entries

    def add(self, spec: RequestSpec, resp: ResponseData) -> HistoryEntry:
        entry = HistoryEntry(
            request=spec,
            status=resp.status,
            elapsed_ms=resp.elapsed_ms,
            error=resp.error,
            timestamp=time.time(),
        )
        self.entries.insert(0, entry)
        del self.entries[self.max_entries :]
        self._save()
        return entry

    def clear(self) -> None:
        self.entries = []
        self._save()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps([e.to_dict() for e in self.entries], indent=2))
