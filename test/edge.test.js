'use strict';

/**
 * Edge cases and adversarial inputs.
 *
 * The goal is not to make every input succeed, but to make every failure land in
 * one of two buckets: a clear error from cachetrace itself, or exactly the same
 * behaviour upstream would produce. Silent nonsense is the only unacceptable
 * outcome.
 */

const test = require('node:test');
const assert = require('node:assert');

const { replay } = require('../lib/replay');
const { explain } = require('../lib/index');
const CachePolicy = require('http-cache-semantics');

const NOW = Date.parse('Sat, 24 Oct 2026 07:28:00 GMT');
const DATE = 'Sat, 24 Oct 2026 07:28:00 GMT';

/**
 * @param {Object} resHeaders
 * @param {Object} [req]
 * @returns {Object}
 */
function input(resHeaders, req = {}) {
  return {
    request: Object.assign({ url: '/r', method: 'GET', headers: { host: 'h.test' } }, req),
    response: { status: 200, headers: Object.assign({ date: DATE }, resHeaders) },
    options: {},
  };
}

test('a non-string Cache-Control is rejected with the field name', () => {
  assert.throws(
    () => replay(input({ 'cache-control': ['max-age=60'] }), { now: NOW, responseTime: NOW }),
    /cache-control.*must be a string.*array/
  );
  assert.throws(
    () => replay(input({ 'cache-control': 600 }), { now: NOW, responseTime: NOW }),
    /cache-control.*number/
  );
});

test('a non-string Vary is rejected with the field name', () => {
  assert.throws(
    () => replay(input({ vary: ['accept'] }), { now: NOW, responseTime: NOW }),
    /vary.*must be a string/
  );
});

test('upstream throws on the same inputs, so the rejection is not a behaviour change', () => {
  // Upstream survives storable()/maxAge() with an array Vary and only throws once
  // request matching calls .trim(); cachetrace rejects earlier with a better
  // message, which is why the error names the field.
  const bad = input({ vary: ['accept'] });
  assert.doesNotThrow(() => new CachePolicy(bad.request, bad.response, {}).maxAge());
  assert.throws(() =>
    new CachePolicy(bad.request, bad.response, {}).evaluateRequest(bad.request)
  );
});

test('NaN and negative clocks are rejected', () => {
  assert.throws(() => explain(input({ 'cache-control': 'max-age=60' }), { now: NaN }), /finite epoch/);
  assert.throws(
    () => explain(input({ 'cache-control': 'max-age=60' }), { ageSeconds: -5 }),
    /non-negative/
  );
});

test('missing method and status fall back to GET and 200, like upstream', () => {
  const r = replay(
    {
      request: { url: '/r', headers: { host: 'h.test' } },
      response: { headers: { date: DATE, 'cache-control': 'max-age=60' } },
      options: {},
    },
    { now: NOW, responseTime: NOW }
  );
  assert.strictEqual(r.verdict.status, 200);
  assert.strictEqual(r.state.method, 'GET');
  assert.strictEqual(r.verdict.storable, true);
});

test('a Vary header made only of commas does not match anything', () => {
  const r = replay(input({ 'cache-control': 'max-age=60', vary: ',' }), {
    now: NOW,
    responseTime: NOW,
  });
  // split on /\s*,\s*/ yields two empty names, which are skipped
  assert.strictEqual(r.verdict.reuse, true);
});

test('an empty Cache-Control is treated as absent', () => {
  const r = replay(input({ 'cache-control': '' }), { now: NOW, responseTime: NOW });
  assert.strictEqual(r.verdict.storable, true, '200 is cacheable by default');
  assert.strictEqual(r.verdict.maxAge, 0);
});

test('a whitespace-only Cache-Control does not throw', () => {
  const r = replay(input({ 'cache-control': '   ' }), { now: NOW, responseTime: NOW });
  assert.strictEqual(r.verdict.maxAge, 0);
});

test('max-age larger than the safe integer range still resolves', () => {
  const r = replay(input({ 'cache-control': 'max-age=999999999999999999999' }), {
    now: NOW,
    responseTime: NOW,
  });
  assert.ok(Number.isFinite(r.verdict.maxAge));
  assert.ok(r.verdict.maxAge > 0);
  // must still agree with upstream
  const policy = new CachePolicy(input({ 'cache-control': 'max-age=999999999999999999999' }).request, input({ 'cache-control': 'max-age=999999999999999999999' }).response, {});
  assert.strictEqual(r.verdict.maxAge, policy.maxAge());
});

test('a negative max-age is passed through as a negative lifetime, like upstream', () => {
  // Upstream uses parseInt and does not clamp, so maxAge() returns -60 and the
  // entry counts as stale immediately. Only timeToLive() clamps to zero.
  const r = replay(input({ 'cache-control': 'max-age=-60' }), { now: NOW, responseTime: NOW });
  const policy = new CachePolicy(
    input({ 'cache-control': 'max-age=-60' }).request,
    input({ 'cache-control': 'max-age=-60' }).response,
    {}
  );
  assert.strictEqual(r.verdict.maxAge, -60);
  assert.strictEqual(r.verdict.maxAge, policy.maxAge(), 'must agree with upstream');
  assert.strictEqual(r.verdict.timeToLive, 0);
  assert.strictEqual(r.verdict.reuse, false);
});

test('prototype-shaped header names do not pollute shared objects', () => {
  const headers = JSON.parse(
    '{"date":"' + DATE + '","cache-control":"max-age=60, __proto__=x, constructor=y"}'
  );
  const r = replay(
    { request: { url: '/r', method: 'GET', headers: { host: 'h.test' } }, response: { status: 200, headers }, options: {} },
    { now: NOW, responseTime: NOW }
  );
  assert.strictEqual(({}).x, undefined, 'Object.prototype must not be polluted');
  assert.strictEqual(r.verdict.maxAge, 60);
});

test('an unparseable Expires falls back rather than throwing', () => {
  const r = replay(input({ expires: 'not-a-date' }), { now: NOW, responseTime: NOW });
  assert.strictEqual(r.verdict.maxAge, 0);
});

test('a request with no headers object is rejected', () => {
  assert.throws(
    () => replay({ request: {}, response: { headers: {} } }, { now: NOW }),
    /request.headers is required/
  );
});

test('an invalid URL is tolerated when a host header exists', () => {
  const r = replay(
    { request: { url: 'not a url', method: 'GET', headers: { host: 'h.test' } }, response: { status: 200, headers: { date: DATE, 'cache-control': 'max-age=60' } }, options: {} },
    { now: NOW, responseTime: NOW }
  );
  assert.strictEqual(r.verdict.storable, true);
});

test('falsy non-string header values are accepted, as upstream accepts them', () => {
  // Upstream's parseCacheControl does `if (!header) return cc`, so 0, false and
  // '' are all treated as an absent header rather than as a type error.
  for (const value of [0, false, '', null]) {
    const r = replay(input({ 'cache-control': value }), { now: NOW, responseTime: NOW });
    const policy = new CachePolicy(
      input({ 'cache-control': value }).request,
      input({ 'cache-control': value }).response,
      {}
    );
    assert.strictEqual(r.verdict.maxAge, policy.maxAge(), `maxAge differs for ${String(value)}`);
    assert.strictEqual(r.verdict.storable, policy.storable());
  }
});

test('a truthy non-string request Cache-Control is rejected with the field name', () => {
  assert.throws(
    () =>
      replay(
        { request: { url: '/r', method: 'GET', headers: { host: 'h.test', 'cache-control': [] } }, response: { status: 200, headers: { date: DATE } }, options: {} },
        { now: NOW, responseTime: NOW }
      ),
    /request\.headers\["cache-control"\]/
  );
});

test('Vary matching reproduces upstream absent-vs-undefined asymmetry', () => {
  // Stored request carries the field explicitly as undefined; the new request
  // omits it. Upstream yields cachedValue === undefined and newValue === false,
  // so they do not match. Normalising absent to undefined would wrongly match.
  const stored = {
    url: '/r',
    method: 'GET',
    headers: { host: 'h.test', 'accept-encoding': undefined },
  };
  const res = {
    status: 200,
    headers: { date: DATE, 'cache-control': 'max-age=600', vary: 'accept-encoding' },
  };
  const r = replay({ request: stored, response: res, options: {} }, {
    now: NOW,
    responseTime: NOW,
    request: { url: '/r', method: 'GET', headers: { host: 'h.test' } },
  });
  const policy = new CachePolicy(stored, res, {});
  policy._responseTime = NOW;
  policy.now = () => NOW;
  const upstreamReuse = policy.evaluateRequest({ url: '/r', method: 'GET', headers: { host: 'h.test' } }).response !== undefined;
  assert.strictEqual(r.verdict.reuse, upstreamReuse);
  assert.strictEqual(r.verdict.reuse, false);
});
