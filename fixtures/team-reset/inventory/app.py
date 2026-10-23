from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class StockResponse(BaseModel):
    sku: str
    available: int

@app.get('/api/stock/{sku}', response_model=StockResponse)
def get_stock(sku: str) -> StockResponse:
    return StockResponse(sku=sku, available=10)
