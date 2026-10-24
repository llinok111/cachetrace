'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { explain } = require('../lib/index');

const NOW = Date.parse('Sat, 24 Oct 2026 07:28:00 GMT');
const DATE = 'Sat, 24 Oct 2026 07:28:00 GMT';

/**
 * @param {Object} resHeaders
 * @param {Object} [extra]
 * @returns {Object}
 */
function fixture(resHeaders, extra = {}) {
  return {
    request: Object.assign(
      { url: '/r', method: 'GET', headers: { host: 'h.test' } },
      extra.request || {}
    ),
    response: {
      status: extra.status || 200,
      headers: Object.assign({ date: DATE }, resHeaders),
    },
    options: extra.options || {},
  };
}

/**
 * @param {Object} input
 * @returns {Object}
 */
function run(input) {
  return explain(input, { now: NOW, responseTime: NOW });
}

/**
 * @param {Object} explained
 * @param {string} code
 * @returns {boolean}
 */
function has(explained, code) {
  return explained.risks.some((r) => r.code === code);
}

test('a healthy immutable asset produces no findings', () => {
  const e = run(fixture({ 'cache-control': 'public, max-age=31536000, immutable' }));
  assert.deepStrictEqual(e.risks, []);
  assert.strictEqual(e.consistent, true);
});

test('dead-cache-entry fires only when the wildcard is padded or listed', () => {
  const dead = run(fixture({ 'cache-control': 'max-age=600', vary: '* ' }));
  assert.ok(has(dead, 'dead-cache-entry'));
  assert.strictEqual(dead.verdict.timeToLive, 600000);
  assert.strictEqual(dead.verdict.reuse, false);
  const finding = dead.risks.find((r) => r.code === 'dead-cache-entry');
  assert.strictEqual(finding.severity, 'critical');
  assert.match(finding.evidence, /600000ms/);

  const fine = run(fixture({ 'cache-control': 'max-age=600', vary: '*' }));
  assert.ok(!has(fine, 'dead-cache-entry'), 'strict Vary: * is not a dead entry, it is a zero TTL');
  assert.strictEqual(fine.verdict.timeToLive, 0);
});

test('invisible-header-case catches canonical casing the engine cannot read', () => {
  const e = run(fixture({ 'Cache-Control': 'max-age=31536000', Expires: 'Sat, 24 Oct 2026 08:28:00 GMT' }));
  assert.ok(has(e, 'invisible-header-case'));
  const finding = e.risks.find((r) => r.code === 'invisible-header-case');
  assert.match(finding.evidence, /Cache-Control/);
  // and the engine really did ignore it
  assert.strictEqual(e.verdict.maxAge, 0);
});

test('duplicate-directive is reported with the RFC clause', () => {
  const e = run(fixture({ 'cache-control': 'max-age=60, max-age=3600' }));
  assert.ok(has(e, 'duplicate-directive'));
  const finding = e.risks.find((r) => r.code === 'duplicate-directive');
  assert.match(finding.clause, /4\.2\.1/);
  // upstream keeps the last one
  assert.strictEqual(e.verdict.maxAge, 3600);
});

test('quoted-comma-split is reported when a quoted value has a comma', () => {
  const e = run(fixture({ 'cache-control': 'no-cache="set-cookie, authorization", max-age=60' }));
  assert.ok(has(e, 'quoted-comma-split'));
});

test('field-qualified no-cache is flagged as stricter than requested', () => {
  const e = run(fixture({ 'cache-control': 'no-cache="set-cookie", max-age=60' }));
  assert.ok(has(e, 'field-qualified-no-cache'));
  // the engine treats it as blanket no-cache, so the lifetime collapses
  assert.strictEqual(e.verdict.maxAge, 0);
});

test('age-without-date warns that timing falls back to local receive time', () => {
  const e = run({ request: { url: '/r', method: 'GET', headers: { host: 'h.test' } }, response: { status: 200, headers: { age: '30', 'cache-control': 'max-age=600' } } });
  assert.ok(has(e, 'age-without-date'));
});

test('request-bypasses-cache explains a client-side reload', () => {
  const e = run(
    fixture({ 'cache-control': 'max-age=600' }, { request: { headers: { host: 'h.test', 'cache-control': 'no-cache' } } })
  );
  assert.ok(has(e, 'request-bypasses-cache'));
  assert.strictEqual(e.verdict.reuse, false);
});

test('set-cookie-blocks-shared-freshness fires for shared caches only', () => {
  const shared = run(fixture({ 'cache-control': 'max-age=600', 'set-cookie': 'a=1' }));
  assert.ok(has(shared, 'set-cookie-blocks-shared-freshness'));
  assert.strictEqual(shared.verdict.maxAge, 0);

  const priv = run(
    fixture({ 'cache-control': 'max-age=600', 'set-cookie': 'a=1' }, { options: { shared: false } })
  );
  assert.ok(!has(priv, 'set-cookie-blocks-shared-freshness'));
  assert.strictEqual(priv.verdict.maxAge, 600);
});

test('immutable-lifetime-inflation is reported with both units in evidence', () => {
  const e = run(fixture({ 'cache-control': 'public, immutable' }));
  assert.ok(has(e, 'immutable-lifetime-inflation'));
  const finding = e.risks.find((r) => r.code === 'immutable-lifetime-inflation');
  assert.match(finding.evidence, /maxAge=86400000s/);
  assert.match(finding.evidence, /86400000ms/);
  assert.strictEqual(e.verdict.maxAge, 86400000);

  const paired = run(fixture({ 'cache-control': 'public, immutable, max-age=86400' }));
  assert.ok(!has(paired, 'immutable-lifetime-inflation'));
  assert.strictEqual(paired.verdict.maxAge, 86400);
});

test('findings are sorted by severity', () => {
  const e = run(
    fixture(
      { 'cache-control': 'max-age=600, max-age=900', vary: '* ', 'set-cookie': 'a=1' }
    )
  );
  assert.ok(e.risks.length >= 2);
  const order = e.risks.map((r) => r.severity);
  const rank = { critical: 2, warning: 1, info: 0 };
  for (let i = 1; i < order.length; i++) {
    assert.ok(rank[order[i - 1]] >= rank[order[i]], `severity order broken: ${order.join(',')}`);
  }
});
