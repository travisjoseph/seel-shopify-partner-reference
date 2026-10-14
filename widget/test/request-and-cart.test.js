const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildQuoteRequest,
  planCartUpdate,
  isWfdLine,
  QUOTE_ATTRIBUTE,
} = require('../extension/seel-wfd/assets/seel-wfd-core.js');

function deepFreeze(o) {
  Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v));
  return Object.freeze(o);
}

const CART = deepFreeze({
  token: 'cart-token',
  currency: 'USD',
  attributes: {},
  items: [{ variant_id: 1, sku: 'SHIRT', handle: 'shirt', quantity: 2, price: 2495 }],
  total_price: 4990,
});

test('quote request matches the proxy contract and omits browser_ip', () => {
  const body = buildQuoteRequest({
    serviceType: 'acme_shopify-wfp',
    adminDomain: 'acme-dev.myshopify.com',
    cart: CART,
    userId: 'visitor-1',
    referrer: 'https://www.google.com/',
    now: 1700000000000,
  });
  assert.deepEqual(body, {
    type: 'acme_shopify-wfp',
    admin_domain: 'acme-dev.myshopify.com',
    cart_info: CART,
    customer_info: { user_id: 'visitor-1', referrer_url: 'https://www.google.com/', timestamp_in_ms: 1700000000000 },
  });
  assert.equal(JSON.stringify(body).includes('browser_ip'), false);
});

test('cart_info is the /cart.js object itself, unmodified', () => {
  const body = buildQuoteRequest({ serviceType: 't', adminDomain: 'd', cart: CART, now: 1 });
  assert.equal(body.cart_info, CART);
  assert.equal(body.customer_info.user_id, '');
});

const CFG = { wfdSku: 'SEEL-WFD', wfdProductHandle: 'worry-free-delivery' };
const QUOTE = { quote_id: 'q-1' };
const wfdLine = (variant_id, quantity = 1) => ({ variant_id, sku: 'SEEL-WFD', handle: 'worry-free-delivery', quantity });

test('opting in adds the matched variant at qty 1 and writes wfp_quote_id', () => {
  const plan = planCartUpdate(CART, { name: 'opted_in', quote: QUOTE, variant: '1002' }, CFG);
  assert.deepEqual(plan, { updates: { 1002: 1 }, attributes: { wfp_quote_id: 'q-1' } });
  assert.equal(QUOTE_ATTRIBUTE, 'wfp_quote_id');
});

test('re-quote swaps the stale WFD variant and forces quantity 1', () => {
  const cart = { ...CART, attributes: { wfp_quote_id: 'q-0' }, items: [...CART.items, wfdLine(1001, 3)] };
  const plan = planCartUpdate(cart, { name: 'opted_in', quote: QUOTE, variant: '1002' }, CFG);
  assert.deepEqual(plan, { updates: { 1001: 0, 1002: 1 }, attributes: { wfp_quote_id: 'q-1' } });

  const sameVariant = { ...cart, items: [...CART.items, wfdLine(1002, 3)] };
  assert.deepEqual(planCartUpdate(sameVariant, { name: 'opted_in', quote: QUOTE, variant: '1002' }, CFG).updates, { 1002: 1 });
});

test('opt-out and hidden remove WFD lines and clear the quote id to an empty string', () => {
  const cart = { ...CART, attributes: { wfp_quote_id: 'q-1' }, items: [...CART.items, wfdLine(1002)] };
  for (const state of [{ name: 'offered', quote: QUOTE, variant: '1002' }, { name: 'hidden', reason: 'quote_rejected' }]) {
    assert.deepEqual(planCartUpdate(cart, state, CFG), { updates: { 1002: 0 }, attributes: { wfp_quote_id: '' } });
  }
});

test('a cart already in the desired shape needs no write', () => {
  const cart = { ...CART, attributes: { wfp_quote_id: 'q-1' }, items: [...CART.items, wfdLine(1002)] };
  assert.equal(planCartUpdate(cart, { name: 'opted_in', quote: QUOTE, variant: '1002' }, CFG), null);
  assert.equal(planCartUpdate(CART, { name: 'offered', quote: QUOTE, variant: '1002' }, CFG), null);
});

test('transient states never touch the cart', () => {
  const cart = { ...CART, items: [...CART.items, wfdLine(1002)] };
  for (const name of ['idle', 'quoting', 'error']) assert.equal(planCartUpdate(cart, { name }, CFG), null);
});

test('WFD lines are identified by SKU, by handle only when SKU is blank', () => {
  const sameHandleOtherSku = { sku: 'OTHER', handle: 'worry-free-delivery' };
  assert.equal(isWfdLine(sameHandleOtherSku, CFG), false);
  assert.equal(isWfdLine({ sku: 'SEEL-WFD', handle: 'x' }, CFG), true);
  assert.equal(isWfdLine(sameHandleOtherSku, { wfdSku: '', wfdProductHandle: 'worry-free-delivery' }), true);
  assert.equal(isWfdLine({ sku: '', handle: 'x' }, { wfdSku: '', wfdProductHandle: '' }), false);
});
