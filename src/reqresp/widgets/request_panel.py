from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.message import Message
from textual.widgets import Button, Input, Label, Select, TabbedContent, TabPane, TextArea

from reqresp.models import METHODS, AuthConfig, RequestSpec
from reqresp.widgets.kv_editor import KVEditor


class RequestPanel(Vertical):
    """Linha de URL + abas Params/Headers/Body/Auth."""

    class SendRequested(Message):
        pass

    def compose(self) -> ComposeResult:
        with Horizontal(id="url-bar"):
            yield Select(
                [(m, m) for m in METHODS], value="GET", allow_blank=False, id="method"
            )
            yield Input(placeholder="https://api.exemplo.com/recurso", id="url")
            yield Button("Enviar", variant="primary", id="send")
        with TabbedContent(id="request-tabs"):
            with TabPane("Params", id="tab-params"):
                yield KVEditor("parâmetro", id="params")
            with TabPane("Headers", id="tab-headers"):
                yield KVEditor("header", id="headers")
            with TabPane("Body", id="tab-body"):
                yield Select(
                    [("Sem body", "none"), ("JSON", "json"), ("Texto", "text")],
                    value="none",
                    allow_blank=False,
                    id="body-type",
                )
                yield TextArea.code_editor("", language="json", id="body")
            with TabPane("Auth", id="tab-auth"):
                yield Select(
                    [("Nenhuma", "none"), ("Bearer Token", "bearer"), ("Basic Auth", "basic")],
                    value="none",
                    allow_blank=False,
                    id="auth-type",
                )
                with Vertical(id="auth-bearer", classes="auth-fields"):
                    yield Label("Token")
                    yield Input(placeholder="token", password=True, id="auth-token")
                with Vertical(id="auth-basic", classes="auth-fields"):
                    yield Label("Usuário")
                    yield Input(id="auth-username")
                    yield Label("Senha")
                    yield Input(password=True, id="auth-password")

    def on_mount(self) -> None:
        self._sync_auth_fields("none")
        self._sync_body_editor("none")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "send":
            event.stop()
            self.post_message(self.SendRequested())

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "url":
            event.stop()
            self.post_message(self.SendRequested())

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id == "auth-type":
            self._sync_auth_fields(event.value)
        elif event.select.id == "body-type":
            self._sync_body_editor(event.value)

    def _sync_auth_fields(self, auth_type) -> None:
        self.query_one("#auth-bearer").display = auth_type == "bearer"
        self.query_one("#auth-basic").display = auth_type == "basic"

    def _sync_body_editor(self, body_type) -> None:
        body = self.query_one("#body", TextArea)
        body.display = body_type != "none"
        body.language = "json" if body_type == "json" else None

    def get_spec(self) -> RequestSpec:
        q = self.query_one
        return RequestSpec(
            method=q("#method", Select).value,
            url=q("#url", Input).value,
            params=q("#params", KVEditor).get_pairs(),
            headers=q("#headers", KVEditor).get_pairs(),
            body=q("#body", TextArea).text,
            body_type=q("#body-type", Select).value,
            auth=AuthConfig(
                type=q("#auth-type", Select).value,
                token=q("#auth-token", Input).value,
                username=q("#auth-username", Input).value,
                password=q("#auth-password", Input).value,
            ),
        )

    def set_spec(self, spec: RequestSpec) -> None:
        q = self.query_one
        q("#method", Select).value = spec.method
        q("#url", Input).value = spec.url
        q("#params", KVEditor).set_pairs(spec.params)
        q("#headers", KVEditor).set_pairs(spec.headers)
        q("#body", TextArea).text = spec.body
        q("#body-type", Select).value = spec.body_type
        q("#auth-type", Select).value = spec.auth.type
        q("#auth-token", Input).value = spec.auth.token
        q("#auth-username", Input).value = spec.auth.username
        q("#auth-password", Input).value = spec.auth.password
