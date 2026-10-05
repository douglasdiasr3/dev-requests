import httpx
import respx
from textual.widgets import Input, Static, TextArea

from dev_requests.app import DevRequestsApp
from dev_requests.widgets.history_list import HistoryList


@respx.mock
async def test_send_shows_response_and_records_history(tmp_path):
    respx.get("https://api.test/users").mock(
        return_value=httpx.Response(200, json={"name": "ana"})
    )
    app = DevRequestsApp(history_path=tmp_path / "h.json")
    async with app.run_test(size=(140, 40)) as pilot:
        app.query_one("#url", Input).value = "https://api.test/users"
        await pilot.press("ctrl+s")
        await app.workers.wait_for_complete()
        await pilot.pause()

        status = str(app.query_one("#status-line", Static).render())
        assert status.startswith("200 OK")
        assert '"name": "ana"' in app.query_one("#resp-body", TextArea).text
        assert len(app.query_one(HistoryList).children) == 1


async def test_select_history_entry_restores_request(tmp_path):
    app = DevRequestsApp(history_path=tmp_path / "h.json")
    async with app.run_test(size=(140, 40)) as pilot:
        await pilot.press("ctrl+s")  # URL vazia → erro, mas entra no histórico
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert "URL vazia" in str(app.query_one("#status-line", Static).render())

        app.query_one("#url", Input).value = "mudou"
        history = app.query_one(HistoryList)
        history.focus()
        history.index = 0
        await pilot.press("enter")
        await pilot.pause()
        assert app.query_one("#url", Input).value == ""
