const test = require('node:test');
const assert = require('node:assert/strict');
const { matchVariant, presentmentCents } = require('../extension/seel-wfd/assets/seel-wfd-core.js');

const TABLE = { 1001: 99, 1002: 149, 1003: 199 };

test('exact net price hit returns that variant', () => {
  assert.equal(matchVariant(TABLE, 149), '1002');
});

test('a quote 1 cent off a tier still matches it', () => {
  assert.equal(matchVariant(TABLE, 150), '1002');
  assert.equal(matchVariant(TABLE, 98), '1001');
});

test('closest variant wins when two are within tolerance', () => {
  assert.equal(matchVariant({ 2001: 149, 2002: 150 }, 150), '2002');
});

test('a near miss returns null even though a higher tier exists', () => {
  assert.equal(matchVariant(TABLE, 120), null);
  assert.equal(matchVariant(TABLE, 147), null);
});

test('a premium above every tier returns null instead of the top tier', () => {
  assert.equal(matchVariant(TABLE, 250), null);
});

test('missing table or non-integer target returns null', () => {
  assert.equal(matchVariant(null, 149), null);
  assert.equal(matchVariant(TABLE, 1.49), null);
});

test('presentment amount comes from display_amounts when present', () => {
  const quote = { price: '0.98', currency_code: 'USD', display_amounts: { price: '1,49 € EUR' } };
  assert.equal(presentmentCents(quote, 'EUR'), 149);
});

test('price is used when display_amounts is null and currencies agree', () => {
  assert.equal(presentmentCents({ price: '0.98', currency_code: 'CAD', display_amounts: null }, 'CAD'), 98);
});

test('price in another currency without display_amounts is not matchable', () => {
  assert.equal(presentmentCents({ price: '0.98', currency_code: 'USD', display_amounts: null }, 'EUR'), null);
});
