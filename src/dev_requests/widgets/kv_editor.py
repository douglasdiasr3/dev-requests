from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, DataTable, Input


class KVTable(DataTable):
    BINDINGS = [
        Binding("delete", "remove_row", "Remover"),
        Binding("backspace", "remove_row", "Remover", show=False),
    ]

    def action_remove_row(self) -> None:
        if self.row_count:
            row_key, _ = self.coordinate_to_cell_key(self.cursor_coordinate)
            self.remove_row(row_key)


class KVEditor(Vertical):
    """Editor de pares chave/valor (params, headers)."""

    DEFAULT_CSS = """
    KVEditor { height: 1fr; }
    KVEditor KVTable { height: 1fr; }
    KVEditor .kv-inputs { height: auto; }
    KVEditor .kv-inputs Input { width: 1fr; }
    KVEditor .kv-inputs Button { min-width: 10; }
    """

    def __init__(self, key_placeholder: str = "chave", **kwargs) -> None:
        super().__init__(**kwargs)
        self.key_placeholder = key_placeholder

    def compose(self) -> ComposeResult:
        with Horizontal(classes="kv-inputs"):
            yield Input(placeholder=self.key_placeholder, classes="kv-key")
            yield Input(placeholder="valor", classes="kv-value")
            yield Button("+ Adicionar", classes="kv-add")
        yield KVTable(cursor_type="row", zebra_stripes=True)

    def on_mount(self) -> None:
        self.query_one(KVTable).add_columns("Chave", "Valor")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.has_class("kv-add"):
            event.stop()
            self._add_from_inputs()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        event.stop()
        self._add_from_inputs()

    def _add_from_inputs(self) -> None:
        key_input = self.query_one(".kv-key", Input)
        value_input = self.query_one(".kv-value", Input)
        key = key_input.value.strip()
        if not key:
            key_input.focus()
            return
        self.query_one(KVTable).add_row(key, value_input.value)
        key_input.value = ""
        value_input.value = ""
        key_input.focus()

    def get_pairs(self) -> list[tuple[str, str]]:
        table = self.query_one(KVTable)
        return [
            (str(row[0]), str(row[1]))
            for row in (table.get_row(key) for key in table.rows)
        ]

    def set_pairs(self, pairs: list[tuple[str, str]]) -> None:
        table = self.query_one(KVTable)
        table.clear()
        for key, value in pairs:
            table.add_row(key, value)
