'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { replay } = require('../lib/replay');
const { findNode, failedNodes } = require('../lib/trace');

const NOW = Date.parse('Sat, 24 Oct 2026 07:28:00 GMT');
const DATE = 'Sat, 24 Oct 2026 07:28:00 GMT';

/**
 * @param {Object} overrides
 * @returns {Object}
 */
function build(overrides = {}) {
  const request = Object.assign(
    { url: '/r', method: 'GET', headers: { host: 'h.test' } },
    overrides.request || {}
  );
  request.headers = Object.assign(
    { host: 'h.test' },
    (overrides.request && overrides.request.headers) || {}
  );
  const response = Object.assign({ status: 200 }, overrides.response || {});
  response.headers = Object.assign({ date: DATE }, (overrides.response && overrides.response.headers) || {});
  return {
    request,
    response,
    options: overrides.options || {},
  };
}

/**
 * @param {Object} input
 * @param {Object} [env]
 * @returns {Object}
 */
function run(input, env) {
  return replay(input, Object.assign({ now: NOW, responseTime: NOW }, env || {}));
}

test('a fingerprinted immutable asset is storable with a one-year TTL', () => {
  const r = run(
    build({ response: { headers: { 'cache-control': 'public, max-age=31536000, immutable' } } })
  );
  assert.strictEqual(r.verdict.storable, true);
  assert.strictEqual(r.verdict.maxAge, 31536000);
  assert.strictEqual(r.verdict.reuse, true);
  assert.strictEqual(r.verdict.timeToLive, 31536000 * 1000);
});

test('no-store blocks storage and names the directive', () => {
  const r = run(build({ response: { headers: { 'cache-control': 'no-store, max-age=600' } } }));
  assert.strictEqual(r.verdict.storable, false);
  const node = findNode(r.traces.storable, 'storable.response-no-store');
  assert.strictEqual(node.passed, false);
  assert.match(node.clause, /5\.2\.1\.5/);
});

test('private blocks a shared cache but not a browser cache', () => {
  const shared = run(build({ response: { headers: { 'cache-control': 'private, max-age=600' } } }));
  assert.strictEqual(shared.verdict.storable, false);

  const priv = run(
    build({
      response: { headers: { 'cache-control': 'private, max-age=600' } },
      options: { shared: false },
    })
  );
  assert.strictEqual(priv.verdict.storable, true);
  assert.strictEqual(priv.verdict.maxAge, 600);
});

test('POST is storable only with explicit freshness', () => {
  const bare = run(build({ request: { method: 'POST' }, response: { headers: {} } }));
  assert.strictEqual(bare.verdict.storable, false);
  assert.strictEqual(findNode(bare.traces.storable, 'storable.method').passed, false);

  const explicit = run(
    build({ request: { method: 'POST' }, response: { headers: { 'cache-control': 'max-age=60' } } })
  );
  assert.strictEqual(explicit.verdict.storable, true);
});

test('206 is listed as cacheable-by-default but the engine will not store it', () => {
  const r = run(build({ response: { status: 206, headers: { 'cache-control': 'max-age=60' } } }));
  assert.strictEqual(r.verdict.storable, false);
  const node = findNode(r.traces.storable, 'storable.status-understood');
  assert.strictEqual(node.passed, false);
  assert.match(node.note, /206/);
});

test('a 500 is never stored', () => {
  const r = run(build({ response: { status: 500, headers: { 'cache-control': 'max-age=60' } } }));
  assert.strictEqual(r.verdict.storable, false);
});

test('all failing conditions are reported, not just the first', () => {
  // Upstream short-circuits on no-store and never evaluates private/method.
  const r = run(
    build({
      request: { method: 'PUT' },
      response: { headers: { 'cache-control': 'no-store, private' } },
    })
  );
  const failed = failedNodes(r.traces.storable).map((n) => n.id);
  assert.ok(failed.includes('storable.response-no-store'));
  assert.ok(failed.includes('storable.shared-private'));
  assert.ok(failed.includes('storable.method'));
  assert.ok(failed.length >= 3);
});

test('Vary: * zeroes the lifetime', () => {
  const r = run(build({ response: { headers: { 'cache-control': 'max-age=600', vary: '*' } } }));
  assert.strictEqual(r.verdict.maxAge, 0);
  assert.strictEqual(r.verdict.reuse, false);
});

test('Vary: "* " grants a lifetime but still refuses reuse', () => {
  const r = run(build({ response: { headers: { 'cache-control': 'max-age=600', vary: '* ' } } }));
  assert.strictEqual(r.verdict.maxAge, 600);
  assert.strictEqual(r.verdict.timeToLive, 600000);
  assert.strictEqual(r.verdict.reuse, false);
});

test('must-revalidate forces revalidation before reuse', () => {
  const r = run(
    build({ response: { headers: { 'cache-control': 'max-age=600, must-revalidate' } } })
  );
  assert.strictEqual(r.verdict.storable, true);
  assert.strictEqual(r.verdict.reuse, false);
  assert.strictEqual(r.verdict.revalidationSynchronous, true);
});

test('stale-while-revalidate allows asynchronous reuse inside its window', () => {
  const input = build({
    response: { headers: { 'cache-control': 'max-age=600, stale-while-revalidate=60' } },
  });

  const inside = run(input, { now: NOW + 650_000, responseTime: NOW });
  assert.strictEqual(inside.verdict.reuse, true);
  assert.strictEqual(inside.verdict.revalidationSynchronous, false);

  // 700s is past max-age + stale-while-revalidate (660s), so the grace window is
  // gone and the entry must be revalidated synchronously.
  const outside = run(input, { now: NOW + 700_000, responseTime: NOW });
  assert.strictEqual(outside.verdict.reuse, false);
  assert.strictEqual(outside.verdict.revalidationSynchronous, true);
});

test('min-fresh larger than remaining freshness forces a miss', () => {
  const r = run(
    build({
      request: { headers: { 'cache-control': 'min-fresh=600' } },
      response: { headers: { 'cache-control': 'max-age=600' } },
    }),
    { now: NOW + 100_000, responseTime: NOW }
  );
  assert.strictEqual(r.verdict.reuse, false);
  const node = findNode(r.traces.evaluateRequest, 'evaluate.request-min-fresh');
  assert.strictEqual(node.passed, false);
});

test('max-stale allows serving a stale entry', () => {
  const r = run(
    build({
      request: { headers: { 'cache-control': 'max-stale=3600' } },
      response: { headers: { 'cache-control': 'max-age=600' } },
    }),
    { now: NOW + 700_000, responseTime: NOW }
  );
  assert.strictEqual(r.verdict.reuse, true);
  const node = findNode(r.traces.evaluateRequest, 'evaluate.max-stale');
  assert.strictEqual(node.passed, true);
});

test('request no-cache bypasses a fresh entry', () => {
  const r = run(
    build({
      request: { headers: { 'cache-control': 'no-cache' } },
      response: { headers: { 'cache-control': 'max-age=600' } },
    })
  );
  assert.strictEqual(r.verdict.reuse, false);
  const node = findNode(r.traces.evaluateRequest, 'evaluate.request-no-cache');
  assert.strictEqual(node.passed, false);
});

test('a Vary field mismatch is attributed to the specific field', () => {
  const r = run(
    build({
      request: { headers: { 'accept-encoding': 'br' } },
      response: { headers: { 'cache-control': 'max-age=600', vary: 'accept-encoding' } },
    }),
    { request: { url: '/r', method: 'GET', headers: { host: 'h.test', 'accept-encoding': 'gzip' } } }
  );
  assert.strictEqual(r.verdict.reuse, false);
  const node = findNode(r.traces.evaluateRequest, 'evaluate.match.vary.accept-encoding');
  assert.strictEqual(node.passed, false);
  assert.deepStrictEqual(node.observed, { stored: 'br', presented: 'gzip' });
});

test('Set-Cookie zeroes shared freshness but not private freshness', () => {
  const shared = run(
    build({ response: { headers: { 'cache-control': 'max-age=600', 'set-cookie': 'a=1' } } })
  );
  assert.strictEqual(shared.verdict.maxAge, 0);
  assert.strictEqual(shared.verdict.storable, true);

  const priv = run(
    build({
      response: { headers: { 'cache-control': 'max-age=600', 'set-cookie': 'a=1' } },
      options: { shared: false },
    })
  );
  assert.strictEqual(priv.verdict.maxAge, 600);
});

test('Age header advances the clock without any wall-time passage', () => {
  const r = run(build({ response: { headers: { 'cache-control': 'max-age=600', age: '599' } } }));
  assert.strictEqual(r.verdict.age, 599);
  assert.strictEqual(r.verdict.reuse, true);

  const expired = run(build({ response: { headers: { 'cache-control': 'max-age=600', age: '600' } } }));
  assert.strictEqual(expired.verdict.reuse, false);
});

test('Expires earlier than Date is treated as already expired', () => {
  const r = run(
    build({
      response: {
        headers: {
          expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
          'last-modified': 'Fri, 23 Oct 2026 07:28:00 GMT',
        },
      },
    })
  );
  assert.strictEqual(r.verdict.maxAge, 0);
});

test('Last-Modified produces a heuristic lifetime', () => {
  const r = run(
    build({
      response: { headers: { 'last-modified': 'Fri, 23 Oct 2026 07:28:00 GMT' } },
      options: { cacheHeuristic: 0.1 },
    })
  );
  // exactly one day since last-modified, 10% heuristic
  assert.ok(Math.abs(r.verdict.maxAge - 8640) < 2, `got ${r.verdict.maxAge}`);
});

test('ignoreCargoCult drops the directives it considers nonsense', () => {
  const r = run(
    build({
      response: { headers: { 'cache-control': 'max-age=0, pre-check=0, post-check=0, no-cache' } },
      options: { ignoreCargoCult: true },
    })
  );
  assert.strictEqual(r.verdict.maxAge, 0);
  assert.ok(r.constructorNotes.some((n) => n.kind === 'cargo-cult-override'));
});

test('Pragma: no-cache is honoured only when Cache-Control is absent', () => {
  const withPragma = run(build({ response: { headers: { pragma: 'no-cache' } } }));
  assert.strictEqual(withPragma.verdict.maxAge, 0);

  const withCC = run(
    build({ response: { headers: { pragma: 'no-cache', 'cache-control': 'max-age=600' } } })
  );
  assert.strictEqual(withCC.verdict.maxAge, 600);
});
