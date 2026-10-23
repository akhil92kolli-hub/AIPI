import os

import httpx


def test_order_total_is_numeric_and_uses_billing_price():
    response = httpx.get(f"{os.environ['ORDERS_URL']}/orders/order-1", timeout=5.0)
    assert response.status_code == 200, response.text
    order = response.json()
    assert isinstance(order['total'], (int, float)) and not isinstance(order['total'], bool)
    assert order['total'] == 25.0
    assert order['currency'] == 'USD'
