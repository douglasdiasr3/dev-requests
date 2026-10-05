from __future__ import annotations

import json

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import DataTable, LoadingIndicator, Static, TabbedContent, TabPane, TextArea

from reqresp.models import ResponseData


def format_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def pretty_body(text: str) -> tuple[str, str | None]:
    """Retorna (texto, linguagem); formata JSON quando possível."""
    try:
        return json.dumps(json.loads(text), indent=2, ensure_ascii=False), "json"
    except (ValueError, TypeError):
        return text, None


class ResponsePanel(Vertical):
    def compose(self) -> ComposeResult:
        yield Static("Nenhuma resposta ainda", id="status-line")
        yield LoadingIndicator(id="loading")
        with TabbedContent(id="response-tabs"):
            with TabPane("Body", id="tab-resp-body"):
                yield TextArea("", read_only=True, id="resp-body")
            with TabPane("Headers", id="tab-resp-headers"):
                yield DataTable(id="resp-headers", zebra_stripes=True)

    def on_mount(self) -> None:
        self.query_one("#resp-headers", DataTable).add_columns("Header", "Valor")
        self.set_loading(False)

    def set_loading(self, loading: bool) -> None:
        self.query_one("#loading").display = loading
        self.query_one("#response-tabs").display = not loading
        if loading:
            status = self.query_one("#status-line", Static)
            status.update("Enviando…")
            status.set_classes("")

    def show(self, resp: ResponseData) -> None:
        self.set_loading(False)
        status = self.query_one("#status-line", Static)
        body = self.query_one("#resp-body", TextArea)
        headers = self.query_one("#resp-headers", DataTable)
        headers.clear()

        if resp.error:
            status.update(f"Erro: {resp.error}")
            status.set_classes("error")
            body.language = None
            body.text = resp.error
            return

        status.update(
            f"{resp.status} {resp.reason}  ·  {resp.elapsed_ms:.0f} ms  ·  {format_size(resp.size_bytes)}"
        )
        status.set_classes(f"s{resp.status // 100}xx")
        text, language = pretty_body(resp.body_text)
        body.language = language
        body.text = text
        for key, value in resp.headers:
            headers.add_row(key, value)
