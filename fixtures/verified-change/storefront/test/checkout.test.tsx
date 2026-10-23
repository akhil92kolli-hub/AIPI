import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CheckoutSummary, loadOrder } from '../src/Checkout';

test('React checkout renders the current Orders total', async () => {
  const order = await loadOrder(process.env.ORDERS_URL!);
  const markup = renderToStaticMarkup(<CheckoutSummary order={order} />);
  assert.match(markup, /Checkout total: USD 25\.00/);
});
