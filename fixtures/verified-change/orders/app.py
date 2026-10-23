import os

import httpx
from fastapi import FastAPI, HTTPException

app = FastAPI()


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.get('/orders/{order_id}')
async def get_order(order_id: str):
    async with httpx.AsyncClient(base_url=os.environ['BILLING_URL'], timeout=5.0) as client:
        response = await client.get('/prices/sku-1')
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail='Billing price unavailable')
    total = round(response.json()['unit_price'] * 2, 2)
    return {'id': order_id, 'total': total, 'currency': 'USD'}
