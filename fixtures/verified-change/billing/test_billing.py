import os

import httpx


def test_orders_consumer_calculates_tax_from_numeric_total():
    response = httpx.get(f"{os.environ['ORDERS_URL']}/orders/order-1", timeout=5.0)
    assert response.status_code == 200, response.text
    total = response.json()['total']
    assert isinstance(total, (int, float)) and not isinstance(total, bool)
    assert round(total * 0.08, 2) == 2.0
