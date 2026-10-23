from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import httpx

app = FastAPI()

class OrderRequest(BaseModel):
    sku: str
    quantity: int

class OrderResponse(BaseModel):
    id: str
    total: float
    currency: str

@app.post('/api/orders', response_model=OrderResponse)
async def create_order(request: OrderRequest) -> OrderResponse:
    async with httpx.AsyncClient(base_url='http://inventory.local') as client:
        result = await client.get(f'/api/stock/{request.sku}')
    if result.status_code != 200 or result.json()['available'] < request.quantity:
        raise HTTPException(status_code=409, detail='Insufficient stock')
    return OrderResponse(id='order-1', total=12.50 * request.quantity, currency='USD')
