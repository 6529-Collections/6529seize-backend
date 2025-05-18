import requests
from datetime import datetime
from typing import Callable, List, Dict, Any

MOBULA_HISTORIC_URL = "https://api.mobula.io/api/1/market/history?asset=Ethereum&from=1633046400000"
MOBULA_CURRENT_URL = "https://api.mobula.io/api/1/market/data?asset=Ethereum"

EthPrice = Dict[str, Any]


def sync_eth_usd_price(
    reset: bool,
    get_count: Callable[[], int],
    persist: Callable[[List[EthPrice]], None],
    now_fn: Callable[[], datetime] = datetime.utcnow,
) -> None:
    """Fetch ETH-USD price history or current price and persist."""
    existing = get_count()
    is_reset = reset or existing == 0

    if is_reset:
        resp = requests.get(MOBULA_HISTORIC_URL)
        data = resp.json()
        history = data["data"]["price_history"]
        prices = [
            {
                "timestamp_ms": ts,
                "date": datetime.fromtimestamp(ts / 1000.0),
                "usd_price": price,
            }
            for ts, price in history
        ]
        persist(prices)
    else:
        resp = requests.get(MOBULA_CURRENT_URL)
        data = resp.json()
        now = now_fn()
        price = data["data"]["price"]
        prices = [
            {
                "timestamp_ms": int(now.timestamp() * 1000),
                "date": now,
                "usd_price": price,
            }
        ]
        persist(prices)
