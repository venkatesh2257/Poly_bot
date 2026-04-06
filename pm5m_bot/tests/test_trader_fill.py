from pm5m_bot.trader import _order_id_from_post_response, poll_fak_entry_fill


def test_order_id_from_post_dict():
    assert _order_id_from_post_response({"orderID": "0xabc", "success": True}) == "0xabc"
    assert _order_id_from_post_response({"success": False, "orderID": "x"}) is None


def test_poll_fak_entry_fill_partial_then_full():
    class FakeClob:
        def __init__(self) -> None:
            self.calls = 0

        def get_order(self, order_id: str):
            self.calls += 1
            if self.calls == 1:
                return {"size_matched": "0", "status": "LIVE"}
            return {"size_matched": "2.5", "status": "MATCHED"}

    matched, st = poll_fak_entry_fill(FakeClob(), "oid", timeout_sec=5.0, poll_sec=0.01)
    assert matched == 2.5
    assert st == "MATCHED"


def test_poll_fak_entry_fill_terminal_without_fill():
    class FakeClob:
        def get_order(self, order_id: str):
            return {"size_matched": "0", "status": "CANCELED"}

    matched, st = poll_fak_entry_fill(FakeClob(), "oid", timeout_sec=5.0, poll_sec=0.01)
    assert matched == 0.0
    assert st == "CANCELED"
