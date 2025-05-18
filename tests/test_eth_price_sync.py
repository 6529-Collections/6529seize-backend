import builtins
from datetime import datetime
from eth_price_sync import sync_eth_usd_price, MOBULA_HISTORIC_URL, MOBULA_CURRENT_URL
import pytest

class DummyResp:
    def __init__(self, json_data):
        self._json_data = json_data
    def json(self):
        return self._json_data


def test_sync_historic_prices_when_reset(monkeypatch):
    history = [[1600000000000, 1000.0], [1600003600000, 1010.0]]
    called = {}

    def fake_get(url):
        assert url == MOBULA_HISTORIC_URL
        return DummyResp({"data": {"price_history": history}})

    def fake_count():
        return 5

    def fake_persist(prices):
        called['prices'] = prices

    monkeypatch.setattr('requests.get', fake_get)

    sync_eth_usd_price(True, fake_count, fake_persist)

    assert called['prices'] == [
        {
            "timestamp_ms": history[0][0],
            "date": datetime.fromtimestamp(history[0][0] / 1000.0),
            "usd_price": history[0][1],
        },
        {
            "timestamp_ms": history[1][0],
            "date": datetime.fromtimestamp(history[1][0] / 1000.0),
            "usd_price": history[1][1],
        },
    ]


def test_sync_current_price_when_data_exists(monkeypatch):
    now = datetime(2020, 1, 1, 0, 0, 0)
    called = {}

    def fake_get(url):
        assert url == MOBULA_CURRENT_URL
        return DummyResp({"data": {"price": 1234.5}})

    def fake_count():
        return 1

    def fake_persist(prices):
        called['prices'] = prices

    monkeypatch.setattr('requests.get', fake_get)

    sync_eth_usd_price(False, fake_count, fake_persist, now_fn=lambda: now)

    assert called['prices'] == [
        {
            "timestamp_ms": int(now.timestamp() * 1000),
            "date": now,
            "usd_price": 1234.5,
        }
    ]
