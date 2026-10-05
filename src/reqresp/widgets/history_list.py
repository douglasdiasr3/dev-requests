from __future__ import annotations

from urllib.parse import urlsplit

from rich.text import Text
from textual.message import Message
from textual.widgets import Label, ListItem, ListView

from reqresp.history import HistoryEntry

STATUS_STYLES = {2: "green", 3: "cyan", 4: "yellow", 5: "red"}


def entry_label(entry: HistoryEntry) -> Text:
    req = entry.request
    parts = urlsplit(req.url if "://" in req.url else "http://" + req.url)
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    text = Text()
    text.append(f"{req.method:<6}", style="bold magenta")
    if entry.error:
        text.append("ERR ", style="bold red")
    else:
        text.append(f"{entry.status} ", style=STATUS_STYLES.get(entry.status // 100, ""))
    text.append(f"{parts.netloc}{path}")
    return text


class HistoryList(ListView):
    class EntrySelected(Message):
        def __init__(self, entry: HistoryEntry) -> None:
            super().__init__()
            self.entry = entry

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._entries: list[HistoryEntry] = []

    def set_entries(self, entries: list[HistoryEntry]) -> None:
        self._entries = list(entries)
        self.clear()
        self.extend(ListItem(Label(entry_label(e))) for e in self._entries)

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        event.stop()
        index = self.index
        if index is not None and 0 <= index < len(self._entries):
            self.post_message(self.EntrySelected(self._entries[index]))
