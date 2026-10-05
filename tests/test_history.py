from reqresp.history import History
from reqresp.models import AuthConfig, RequestSpec, ResponseData


def test_roundtrip(tmp_path):
    path = tmp_path / "history.json"
    spec = RequestSpec(
        method="POST",
        url="https://api.test",
        params=[("a", "1")],
        headers=[("X", "y")],
        body="{}",
        body_type="json",
        auth=AuthConfig(type="bearer", token="t"),
    )
    History(path).add(spec, ResponseData(status=201, elapsed_ms=12.5))

    entries = History(path).load()
    assert len(entries) == 1
    assert entries[0].request == spec
    assert entries[0].status == 201
    assert entries[0].elapsed_ms == 12.5


def test_newest_first_and_limit(tmp_path):
    history = History(tmp_path / "h.json", max_entries=50)
    for i in range(60):
        history.add(RequestSpec(url=f"https://api.test/{i}"), ResponseData(status=200))

    entries = History(tmp_path / "h.json").load()
    assert len(entries) == 50
    assert entries[0].request.url == "https://api.test/59"


def test_clear_and_corrupt_file(tmp_path):
    path = tmp_path / "h.json"
    history = History(path)
    history.add(RequestSpec(url="x"), ResponseData(error="boom"))
    history.clear()
    assert History(path).load() == []

    path.write_text("not json")
    assert History(path).load() == []
