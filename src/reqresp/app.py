from __future__ import annotations

from pathlib import Path

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, Label

from reqresp.history import DEFAULT_PATH, History
from reqresp.http_client import send
from reqresp.widgets.history_list import HistoryList
from reqresp.widgets.request_panel import RequestPanel
from reqresp.widgets.response_panel import ResponsePanel


class ReqRespApp(App):
    TITLE = "reqresp"
    SUB_TITLE = "cliente HTTP"
    CSS_PATH = "app.tcss"
    BINDINGS = [
        Binding("ctrl+s", "send", "Enviar", priority=True),
        Binding("ctrl+enter", "send", "Enviar", show=False, priority=True),
        Binding("ctrl+b", "toggle_history", "Histórico"),
        Binding("ctrl+l", "clear_history", "Limpar histórico"),
        Binding("ctrl+q", "quit", "Sair"),
    ]

    def __init__(self, history_path: Path = DEFAULT_PATH) -> None:
        super().__init__()
        self.history = History(history_path)

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal():
            with Vertical(id="sidebar"):
                yield Label("Histórico", classes="panel-title")
                yield HistoryList(id="history")
            with Vertical(id="main"):
                yield RequestPanel(id="request")
                yield ResponsePanel(id="response")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one(HistoryList).set_entries(self.history.load())
        self.query_one("#url").focus()

    def on_request_panel_send_requested(self, _: RequestPanel.SendRequested) -> None:
        self.action_send()

    def on_history_list_entry_selected(self, event: HistoryList.EntrySelected) -> None:
        self.query_one(RequestPanel).set_spec(event.entry.request)
        self.query_one("#url").focus()

    def action_send(self) -> None:
        self.run_request()

    def action_toggle_history(self) -> None:
        sidebar = self.query_one("#sidebar")
        sidebar.display = not sidebar.display

    def action_clear_history(self) -> None:
        self.history.clear()
        self.query_one(HistoryList).set_entries([])
        self.notify("Histórico limpo")

    @work(exclusive=True)
    async def run_request(self) -> None:
        spec = self.query_one(RequestPanel).get_spec()
        response_panel = self.query_one(ResponsePanel)
        response_panel.set_loading(True)
        resp = await send(spec)
        response_panel.show(resp)
        self.history.add(spec, resp)
        self.query_one(HistoryList).set_entries(self.history.entries)
