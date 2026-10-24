'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { counterfactual, enumerateInterventions, measure } = require('../lib/counterfactual');

const NOW = Date.parse('Sat, 24 Oct 2026 07:28:00 GMT');
const DATE = 'Sat, 24 Oct 2026 07:28:00 GMT';

/**
 * @param {Object} headers
 * @param {Object} [extra]
 * @returns {Object}
 */
function fixture(headers, extra = {}) {
  return {
    request: Object.assign(
      { url: '/r', method: 'GET', headers: { host: 'h.test' } },
      extra.request || {}
    ),
    response: { status: extra.status || 200, headers: Object.assign({ date: DATE }, headers) },
    options: extra.options || {},
  };
}

const CASES = [
  { name: 'immutable asset (already good)', input: fixture({ 'cache-control': 'public, max-age=31536000, immutable' }) },
  { name: 'private response', input: fixture({ 'cache-control': 'private, max-age=600' }) },
  { name: 'no-store response', input: fixture({ 'cache-control': 'no-store' }) },
  { name: 'no-cache response', input: fixture({ 'cache-control': 'no-cache' }) },
  { name: 'set-cookie shared', input: fixture({ 'cache-control': 'max-age=600', 'set-cookie': 'a=1' }) },
  { name: 'vary wildcard padded', input: fixture({ 'cache-control': 'max-age=600', vary: '* ' }) },
  { name: 'vary concrete field', input: fixture({ 'cache-control': 'max-age=600', vary: 'accept-encoding' }, { request: { headers: { host: 'h.test', 'accept-encoding': 'gzip' } } }) },
  { name: 'authenticated request', input: fixture({ 'cache-control': 'max-age=600' }, { request: { headers: { host: 'h.test', authorization: 'Bearer x' } } }) },
  { name: 'no freshness information', input: fixture({}) },
  { name: 'server error', input: fixture({ 'cache-control': 'max-age=600' }, { status: 500 }) },
  { name: 'expired via Age', input: fixture({ 'cache-control': 'max-age=60', age: '3600' }) },
  { name: 'must-revalidate', input: fixture({ 'cache-control': 'max-age=600, must-revalidate' }) },
];

test('every reported fix reproduces its claimed effect when applied', () => {
  let verified = 0;

  for (const testCase of CASES) {
    const cf = counterfactual(testCase.input, { now: NOW, responseTime: NOW });
    const interventions = enumerateInterventions(testCase.input);

    for (const fix of cf.fixes) {
      const intervention = interventions.find((i) => i.id === fix.id);
      assert.ok(intervention, `${testCase.name}: fix ${fix.id} has no matching intervention`);

      const mutated = intervention.apply(testCase.input);
      const after = measure(mutated, { now: NOW, responseTime: NOW });

      if (fix.effect.axes.reuse) {
        assert.strictEqual(
          after.reuse,
          true,
          `${testCase.name}: ${fix.id} claims reuse but engine says ${after.reuse}`
        );
        assert.strictEqual(cf.baseline.reuse, false, 'a reuse fix only makes sense from false');
      }
      if (fix.effect.axes.storable) {
        assert.strictEqual(
          after.storable,
          true,
          `${testCase.name}: ${fix.id} claims storable but engine says ${after.storable}`
        );
      }
      if (fix.effect.axes.timeToLive) {
        assert.ok(
          after.timeToLive > fix.effect.axes.timeToLive.from,
          `${testCase.name}: ${fix.id} claims a TTL gain but ${after.timeToLive} <= ${fix.effect.axes.timeToLive.from}`
        );
      }
      verified += 1;
    }
  }

  assert.ok(verified > 10, `only ${verified} fixes were verified across the corpus`);
});

test('an already-optimal response yields no fixes', () => {
  const cf = counterfactual(
    fixture({ 'cache-control': 'public, max-age=31536000, immutable' }),
    { now: NOW, responseTime: NOW }
  );
  assert.strictEqual(cf.baseline.reuse, true);
  assert.deepStrictEqual(cf.fixes, []);
});

test('a 500 produces no fix, because no header change can make it cacheable', () => {
  const cf = counterfactual(fixture({ 'cache-control': 'max-age=600' }, { status: 500 }), {
    now: NOW,
    responseTime: NOW,
  });
  assert.strictEqual(cf.baseline.storable, false);
  // The only status rewrite is graded high risk and does flip storability, so if
  // one is returned it must be exactly that one.
  for (const fix of cf.fixes) {
    assert.strictEqual(fix.id, 'set-response-status:200');
    assert.strictEqual(fix.risk, 'high');
  }
});

test('fixes are ordered by impact: reuse before TTL', () => {
  const cf = counterfactual(fixture({ 'cache-control': 'max-age=600', vary: '* ' }), {
    now: NOW,
    responseTime: NOW,
  });
  assert.ok(cf.fixes.length > 0);
  assert.ok(
    cf.fixes[0].effect.axes.reuse,
    `expected a reuse fix first, got ${cf.fixes[0].id}`
  );
});

test('every fix carries a risk grade and an explanation', () => {
  for (const testCase of CASES) {
    const cf = counterfactual(testCase.input, { now: NOW, responseTime: NOW });
    for (const fix of cf.fixes) {
      assert.ok(['low', 'medium', 'high'].includes(fix.risk), `${fix.id} has risk ${fix.risk}`);
      assert.ok(fix.riskNote && fix.riskNote.length > 20, `${fix.id} needs a real caveat`);
      assert.strictEqual(fix.verified, true);
    }
  }
});

test('the counterfactual never mutates the input it was given', () => {
  const input = fixture({ 'cache-control': 'private, max-age=600', vary: '* ' });
  const snapshot = JSON.stringify(input);
  counterfactual(input, { now: NOW, responseTime: NOW });
  assert.strictEqual(JSON.stringify(input), snapshot);
});

test('removing no-store is graded high risk, never silently suggested', () => {
  const cf = counterfactual(fixture({ 'cache-control': 'no-store' }), {
    now: NOW,
    responseTime: NOW,
  });
  const removal = cf.fixes.find((f) => f.id === 'remove-response-directive:no-store');
  assert.ok(removal, 'removing no-store does flip storability and should be listed');
  assert.strictEqual(removal.risk, 'high');
  assert.match(removal.riskNote, /forbade|discard/i);
});

test('lower-casing directive names is offered as a zero-semantics repair', () => {
  const cf = counterfactual(fixture({ 'cache-control': 'Max-Age=600' }), {
    now: NOW,
    responseTime: NOW,
  });
  assert.strictEqual(cf.baseline.timeToLive, 0, 'baseline must have no lifetime');

  const fix = cf.fixes.find((f) => f.id === 'normalize-directive-case');
  assert.ok(fix, 'lower-casing must be offered');
  assert.strictEqual(fix.risk, 'low', 'this repair cannot change client-visible semantics');
  assert.strictEqual(fix.effect.axes.timeToLive.from, 0);
  assert.ok(fix.effect.axes.timeToLive.to >= 600000);
});
