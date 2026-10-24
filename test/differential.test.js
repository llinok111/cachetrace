'use strict';

/**
 * Differential tests.
 *
 * The replay is an independent implementation, so the only honest way to claim it
 * explains upstream behaviour is to compare the two across a wide, reproducible
 * input space. Every case is generated from a fixed seed, and a mismatch fails the
 * test with the exact input that produced it.
 */

const test = require('node:test');
const assert = require('node:assert');

const { replay } = require('../lib/replay');
const { buildPolicy } = require('../lib/policy');
const { diffAgainstUpstream } = require('../lib/differential');

/**
 * Deterministic LCG so failures are reproducible from the seed alone.
 * @param {number} seed
 * @returns {() => number}
 */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const METHODS = ['GET', 'GET', 'GET', 'HEAD', 'POST', 'PUT', 'DELETE'];
const STATUSES = [200, 200, 200, 203, 204, 206, 301, 302, 304, 404, 410, 500];
const RESPONSE_DIRECTIVES = [
  'max-age=0',
  'max-age=60',
  'max-age=3600',
  's-maxage=600',
  'public',
  'private',
  'no-cache',
  'no-store',
  'must-revalidate',
  'proxy-revalidate',
  'immutable',
  'stale-while-revalidate=30',
  'stale-if-error=60',
  'no-cache="set-cookie"',
];
const VARIES = [undefined, undefined, 'accept-encoding', 'accept, accept-encoding', '*', '* ', ' *', '*, accept', 'accept, *'];
const REQUEST_DIRECTIVES = [undefined, undefined, 'no-cache', 'max-age=0', 'max-age=5', 'min-fresh=10', 'max-stale', 'max-stale=100', 'no-store'];
const AGES = [undefined, undefined, '0', '30', '600', '86400'];

const BASE_DATE = 'Sat, 24 Oct 2026 07:28:00 GMT';
const BASE_NOW = Date.parse(BASE_DATE);

/**
 * @param {() => number} rand
 * @param {'mixed'|'cacheable'} [bias]
 * @returns {Object}
 */
function generateCase(rand, bias = 'mixed') {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const chance = (p) => rand() < p;

  const directives = [];
  let count = Math.floor(rand() * 4);
  if (bias === 'cacheable') {
    // Keep the response on the happy path so the reuse branches actually get
    // exercised; a purely uniform generator reaches `reuse === true` only ~3% of
    // the time, which would leave the whole revalidation logic untested.
    const positive = [
      'max-age=60',
      'max-age=3600',
      's-maxage=600, public',
      'max-age=3600, stale-while-revalidate=30',
      'max-age=60, stale-if-error=60',
      'max-age=3600, must-revalidate',
    ];
    directives.push(...pick(positive).split(', '));
    count = 0;
  }
  for (let i = 0; i < count; i++) {
    const d = pick(RESPONSE_DIRECTIVES);
    if (!directives.includes(d)) directives.push(d);
  }

  const resHeaders = { date: BASE_DATE };
  if (directives.length) resHeaders['cache-control'] = directives.join(', ');
  const vary =
    bias === 'cacheable'
      ? pick([undefined, undefined, 'accept-encoding', 'accept, accept-encoding', '*', '* '])
      : pick(VARIES);
  if (vary !== undefined) resHeaders.vary = vary;
  if (bias !== 'cacheable' && chance(0.25)) resHeaders['set-cookie'] = 'sid=1; Path=/';
  const age = bias === 'cacheable' ? pick([undefined, '0', '0', '30', '100']) : pick(AGES);
  if (age !== undefined) resHeaders.age = age;
  if (chance(0.2)) resHeaders.expires = chance(0.5) ? 'Sat, 24 Oct 2026 08:28:00 GMT' : 'Thu, 01 Jan 1970 00:00:00 GMT';
  if (chance(0.25)) resHeaders['last-modified'] = 'Fri, 23 Oct 2026 07:28:00 GMT';
  if (chance(0.3)) resHeaders.etag = '"abc"';

  const reqHeaders = { host: 'example.test' };
  const reqDirective =
    bias === 'cacheable'
      ? pick([undefined, 'max-age=600', 'max-age=0', 'min-fresh=10', 'max-stale', 'max-stale=100', 'no-cache'])
      : pick(REQUEST_DIRECTIVES);
  if (reqDirective !== undefined) reqHeaders['cache-control'] = reqDirective;
  if (chance(0.2)) reqHeaders.authorization = 'Bearer token';
  if (chance(0.3)) reqHeaders['accept-encoding'] = 'gzip';
  if (chance(0.2)) reqHeaders.accept = 'application/json';

  const method = bias === 'cacheable' ? 'GET' : pick(METHODS);
  const status = bias === 'cacheable' ? 200 : pick(STATUSES);

  const newReqHeaders = { host: 'example.test' };
  const sendEncoding = chance(0.6);
  if (sendEncoding) newReqHeaders['accept-encoding'] = 'gzip';
  if (chance(0.2) && !sendEncoding) newReqHeaders.accept = 'application/json';
  else if (chance(0.2)) newReqHeaders.accept = 'application/json';

  return {
    input: {
      request: { url: '/resource', method, headers: reqHeaders },
      response: { status, headers: resHeaders },
      options: { shared: bias === 'cacheable' ? true : chance(0.75) },
    },
    request: { url: '/resource', method, headers: newReqHeaders },
  };
}

test('replay agrees with upstream across 1500 generated cases', () => {
  const rand = makeRandom(20261024);
  const divergences = [];
  let reuseHits = 0;

  for (let i = 0; i < 1500; i++) {
    const c = generateCase(rand);
    const env = { now: BASE_NOW, responseTime: BASE_NOW };
    const replayed = replay(c.input, Object.assign({}, env, { request: c.request }));
    if (replayed.verdict.reuse) reuseHits += 1;
    const policy = buildPolicy(c.input, env);
    const diff = diffAgainstUpstream(policy, replayed, c.request);
    if (diff.divergences.length) {
      divergences.push({ case: c.input, request: c.request, divergences: diff.divergences });
    }
  }

  if (divergences.length) {
    const first = divergences[0];
    assert.fail(
      `${divergences.length} divergence(s) across 1500 cases. First:\n` +
        JSON.stringify(first, null, 2)
    );
  }
  assert.strictEqual(divergences.length, 0);
  assert.ok(
    reuseHits > 20,
    `only ${reuseHits} cases reached the reuse path in the mixed generator; ` +
      'the revalidation branches would be under-tested'
  );
});

test('replay agrees with upstream on the cacheable happy path', () => {
  const rand = makeRandom(9001);
  const divergences = [];
  let reuseHits = 0;
  let staleHits = 0;

  for (let i = 0; i < 900; i++) {
    const c = generateCase(rand, 'cacheable');
    const env = { now: BASE_NOW, responseTime: BASE_NOW };
    const replayed = replay(c.input, Object.assign({}, env, { request: c.request }));
    if (replayed.verdict.reuse) reuseHits += 1;
    if (!replayed.verdict.reuse && replayed.verdict.storable) staleHits += 1;
    const policy = buildPolicy(c.input, env);
    const diff = diffAgainstUpstream(policy, replayed, c.request);
    if (diff.divergences.length) {
      divergences.push({ case: c.input, request: c.request, divergences: diff.divergences });
    }
  }

  assert.deepStrictEqual(
    divergences.slice(0, 1),
    [],
    `divergence on cacheable path: ${JSON.stringify(divergences[0], null, 2)}`
  );
  // The generator still injects Vary: *, request no-cache, max-age=0 and
  // must-revalidate on purpose, so reuse lands well below 100%; the floor only
  // guards against the branch silently disappearing from the sample.
  assert.ok(reuseHits > 150, `expected a substantial reuse share, got ${reuseHits}/900`);
  assert.ok(staleHits > 50, `expected some stale-but-stored cases, got ${staleHits}/900`);
});

test('replay agrees with upstream for private caches too', () => {
  const rand = makeRandom(777);
  for (let i = 0; i < 400; i++) {
    const c = generateCase(rand);
    c.input.options = { shared: false };
    const env = { now: BASE_NOW, responseTime: BASE_NOW };
    const replayed = replay(c.input, Object.assign({}, env, { request: c.request }));
    const policy = buildPolicy(c.input, env);
    const diff = diffAgainstUpstream(policy, replayed, c.request);
    assert.deepStrictEqual(
      diff.divergences,
      [],
      `divergence for ${JSON.stringify(c.input)}`
    );
  }
});

test('replay agrees with upstream as the entry ages', () => {
  const rand = makeRandom(4242);
  for (let i = 0; i < 300; i++) {
    const c = generateCase(rand);
    const offsets = [0, 30_000, 600_000, 3_600_000, 86_400_000];
    const offset = offsets[Math.floor(rand() * offsets.length)];
    const env = { now: BASE_NOW + offset, responseTime: BASE_NOW };
    const replayed = replay(c.input, Object.assign({}, env, { request: c.request }));
    const policy = buildPolicy(c.input, env);
    const diff = diffAgainstUpstream(policy, replayed, c.request);
    assert.deepStrictEqual(
      diff.divergences,
      [],
      `divergence at offset ${offset} for ${JSON.stringify(c.input)}`
    );
  }
});

test('a deliberately wrong replay is reported as divergent', () => {
  // Guards the guard: if diffAgainstUpstream silently accepted everything, the
  // three tests above would prove nothing.
  const input = {
    request: { url: '/x', method: 'GET', headers: { host: 'a.test' } },
    response: { status: 200, headers: { 'cache-control': 'max-age=60' } },
    options: { shared: true },
  };
  const env = { now: BASE_NOW, responseTime: BASE_NOW };
  const replayed = replay(input, env);
  replayed.verdict.storable = !replayed.verdict.storable;
  const policy = buildPolicy(input, env);
  const diff = diffAgainstUpstream(policy, replayed, input.request);
  assert.ok(
    diff.divergences.some((d) => d.field === 'storable'),
    'tampered replay must be caught'
  );
});
