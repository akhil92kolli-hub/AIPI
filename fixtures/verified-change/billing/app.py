from fastapi import FastAPI

app = FastAPI()


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.get('/prices/{sku}')
def price(sku: str):
    return {'sku': sku, 'unit_price': 12.5}
