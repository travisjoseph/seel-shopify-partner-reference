const test = require('node:test');
const assert = require('node:assert/strict');
const { initialState, transition, HIDDEN_REASONS } = require('../extension/seel-wfd/assets/seel-wfd-core.js');

const CONFIG = { quoteEndpoint: 'https://partner.example/seel/quotes', defaultOn: false };
const QUOTE = { quote_id: 'q-1', status: 'accepted', price: '1.49', currency_code: 'USD' };

function run(state, ...events) {
  return events.reduce(transition, state);
}

const quoting = () => run(initialState(CONFIG), { type: 'CART_CHANGED' });

test('starts idle, and cart changes start a quote', () => {
  assert.equal(initialState(CONFIG).name, 'idle');
  assert.equal(quoting().name, 'quoting');
});

test('missing quote endpoint hides for good', () => {
  const s = initialState({ defaultOn: true });
  assert.deepEqual(s, { name: 'hidden', optIn: true, reason: HIDDEN_REASONS.NO_QUOTE_ENDPOINT });
  assert.equal(run(s, { type: 'CART_CHANGED' }, { type: 'QUOTE_RESOLVED', quote: QUOTE, variant: '1' }), s);
});

test('resolved quote is offered, then opt in and opt out move between offered and opted_in', () => {
  const offered = transition(quoting(), { type: 'QUOTE_RESOLVED', quote: QUOTE, variant: '1002' });
  assert.deepEqual(offered, { name: 'offered', optIn: false, quote: QUOTE, variant: '1002' });
  const optedIn = transition(offered, { type: 'OPT_IN' });
  assert.deepEqual(optedIn, { name: 'opted_in', optIn: true, quote: QUOTE, variant: '1002' });
  assert.equal(transition(optedIn, { type: 'OPT_OUT' }).name, 'offered');
});

test('defaultOn resolves straight to opted_in', () => {
  const s = run(initialState({ ...CONFIG, defaultOn: true }), { type: 'CART_CHANGED' }, { type: 'QUOTE_RESOLVED', quote: QUOTE, variant: '1' });
  assert.equal(s.name, 'opted_in');
});

test('opt-in intent survives a re-quote', () => {
  const s = run(
    quoting(),
    { type: 'QUOTE_RESOLVED', quote: QUOTE, variant: '1002' },
    { type: 'OPT_IN' },
    { type: 'CART_CHANGED' },
    { type: 'QUOTE_RESOLVED', quote: { ...QUOTE, quote_id: 'q-2' }, variant: '1003' }
  );
  assert.equal(s.name, 'opted_in');
  assert.equal(s.quote.quote_id, 'q-2');
  assert.equal(s.variant, '1003');
});

for (const [type, reason] of [
  ['QUOTE_REJECTED', HIDDEN_REASONS.QUOTE_REJECTED],
  ['NO_VARIANT_MATCH', HIDDEN_REASONS.NO_VARIANT_MATCH],
  ['CURRENCY_UNSUPPORTED', HIDDEN_REASONS.CURRENCY_NOT_SUPPORTED],
]) {
  test(`${type} while quoting hides with reason ${reason}`, () => {
    const s = transition(quoting(), { type });
    assert.equal(s.name, 'hidden');
    assert.equal(s.reason, reason);
  });
}

test('hidden reason strings are the documented ones', () => {
  assert.deepEqual(Object.values(HIDDEN_REASONS).sort(), [
    'currency_not_supported',
    'no_quote_endpoint',
    'no_variant_match',
    'quote_rejected',
  ]);
});

test('a stale quote result outside quoting is ignored', () => {
  const offered = transition(quoting(), { type: 'QUOTE_RESOLVED', quote: QUOTE, variant: '1' });
  assert.equal(transition(offered, { type: 'QUOTE_RESOLVED', quote: QUOTE, variant: '2' }), offered);
  assert.equal(transition(offered, { type: 'NO_VARIANT_MATCH' }), offered);
});

test('FAILED moves to error and a later cart change recovers', () => {
  const err = transition(quoting(), { type: 'FAILED', message: 'HTTP 502' });
  assert.deepEqual(err, { name: 'error', optIn: false, message: 'HTTP 502' });
  assert.equal(transition(err, { type: 'CART_CHANGED' }).name, 'quoting');
});

test('toggling while quoting records intent for the pending quote', () => {
  const s = run(quoting(), { type: 'OPT_IN' }, { type: 'QUOTE_RESOLVED', quote: QUOTE, variant: '1' });
  assert.equal(s.name, 'opted_in');
});
