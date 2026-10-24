'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { audit, parseHAR, parseNDJSON, normalizeEntries } = require('../lib/index');

const NOW = Date.parse('Sat, 24 Oct 2026 07:28:00 GMT');
const HAR_PATH = path.join(__dirname, 'fixtures', 'site.har');

test('HAR headers become an object and Host is derived from the URL', () => {
  const fs = require('node:fs');
  const entries = parseHAR(fs.readFileSync(HAR_PATH, 'utf8'));
  assert.strictEqual(entries.length, 9);
  const first = entries[0];
  assert.strictEqual(first.request.headers.host, 'shop.example.com');
  assert.strictEqual(first.request.headers.accept, '*/*');
  assert.strictEqual(first.derivedHost, true);
});

test('NDJSON is accepted line by line', () => {
  const text = [
    JSON.stringify({
      url: 'https://a.test/x',
      request: { method: 'GET', headers: {} },
      response: { status: 200, headers: { 'cache-control': 'max-age=60' } },
    }),
    '',
    JSON.stringify({
      url: 'https://a.test/y',
      request: { method: 'GET', headers: {} },
      response: { status: 200, headers: { 'cache-control': 'no-store' } },
    }),
  ].join('\n');
  const entries = parseNDJSON(text);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].request.headers.host, 'a.test');
});

test('normalizeEntries refuses input that is not entries', () => {
  assert.throws(() => normalizeEntries({ hello: 'world' }), /unrecognised input/);
  assert.throws(() => normalizeEntries(''), /empty/);
});

test('audit aggregates the HAR fixture correctly', () => {
  const fs = require('node:fs');
  const result = audit(fs.readFileSync(HAR_PATH, 'utf8'), { now: NOW });

  assert.strictEqual(result.total, 9);
  assert.strictEqual(result.engineErrors, 0);
  assert.strictEqual(result.divergenceCount, 0);

  // Only the private API response is outright unstorable in a shared cache. The
  // interesting result is that the other failures hide downstream: no-cache,
  // the padded Vary wildcard, Set-Cookie and the canonical-cased headers all
  // leave the response storable but unusable, which is exactly the class of
  // problem a storage-only checklist never reports.
  assert.strictEqual(result.storage.notStorable, 1);
  assert.ok(result.storage.storable >= 7, `storable=${result.storage.storable}`);
  assert.ok(
    result.reuseState.dead + result.reuseState.unusable >= 4,
    `expected several unusable entries, got dead=${result.reuseState.dead} ` +
      `unusable=${result.reuseState.unusable}`
  );
  // Reusable: the two immutable assets, the 404 (cacheable by default and given
  // max-age), and the POST that carries explicit freshness.
  assert.strictEqual(result.reuseState.reusable, 4);

  const dead = result.findings.find((f) => f.code === 'dead-cache-entry');
  assert.ok(dead, 'the padded Vary wildcard must be found');
  assert.strictEqual(dead.count, 1);
  assert.match(dead.samples[0], /stock/);

  const invisible = result.findings.find((f) => f.code === 'invisible-header-case');
  assert.ok(invisible, 'the canonical-cased Cache-Control must be found');
  assert.match(invisible.samples[0], /legacy/);

  const cookie = result.findings.find((f) => f.code === 'set-cookie-blocks-shared-freshness');
  assert.ok(cookie, 'the Set-Cookie response must be found');
});

test('audit never mutates the source', () => {
  const fs = require('node:fs');
  const raw = fs.readFileSync(HAR_PATH, 'utf8');
  const before = JSON.parse(raw);
  audit(raw, { now: NOW });
  const after = JSON.parse(raw);
  assert.deepStrictEqual(after, before);
});

test('audit recommendations are ranked by affected entry count', () => {
  const fs = require('node:fs');
  const result = audit(fs.readFileSync(HAR_PATH, 'utf8'), { now: NOW });
  assert.ok(result.recommendations.length > 0, 'expected at least one verified recommendation');
  const counts = result.recommendations.map((r) => r.affected);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i - 1] >= counts[i], `recommendations not sorted: ${counts.join(',')}`);
  }
  for (const rec of result.recommendations) {
    assert.ok(['low', 'medium', 'high'].includes(rec.risk));
    assert.ok(rec.riskNote && rec.riskNote.length > 20);
  }
});

test('audit handles every entry of a mixed capture without throwing', () => {
  const fs = require('node:fs');
  const result = audit(fs.readFileSync(HAR_PATH, 'utf8'), { now: NOW, includeEntries: true });
  assert.strictEqual(result.entries.length, 9);
  for (const row of result.entries) {
    assert.ok(typeof row.storable === 'boolean', `entry ${row.id} has no storable verdict`);
    assert.ok(typeof row.timeToLive === 'number', `entry ${row.id} has no TTL`);
  }
});

test('audit reports the private cache view when asked', () => {
  const fs = require('node:fs');
  const shared = audit(fs.readFileSync(HAR_PATH, 'utf8'), { now: NOW, shared: true });
  const priv = audit(fs.readFileSync(HAR_PATH, 'utf8'), { now: NOW, shared: false });
  assert.notStrictEqual(
    shared.storage.storable,
    priv.storage.storable,
    'private caching must differ from shared caching on this capture'
  );
});
