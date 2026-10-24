'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseCacheControl, splitOutsideQuotes } = require('../lib/directives');

test('parses plain directives', () => {
  const parsed = parseCacheControl('public, max-age=31536000, immutable');
  assert.deepStrictEqual(parsed.upstreamView, {
    public: true,
    'max-age': '31536000',
    immutable: true,
  });
  assert.deepStrictEqual(parsed.duplicates, []);
});

test('handles absent and empty headers', () => {
  assert.deepStrictEqual(parseCacheControl(undefined).upstreamView, {});
  assert.deepStrictEqual(parseCacheControl('').upstreamView, {});
  assert.deepStrictEqual(parseCacheControl(null).upstreamView, {});
});

test('quoted comma is split by upstream but not by the strict parser', () => {
  const header = 'no-cache="set-cookie, authorization", max-age=60';
  const parsed = parseCacheControl(header);

  // upstream: naive comma split
  assert.ok(
    Object.keys(parsed.upstreamView).some((k) => k.includes('authorization')),
    'upstream should produce a phantom key from the quoted comma'
  );
  assert.strictEqual(parsed.strictView.get('max-age').value, '60');

  const entry = parsed.strictView.get('no-cache');
  assert.deepStrictEqual(entry.fieldList, ['set-cookie', 'authorization']);
  assert.ok(parsed.quirks.some((q) => q.kind === 'quoted-comma'));
});

test('detects duplicate directives and keeps the last for upstream', () => {
  const parsed = parseCacheControl('max-age=60, max-age=3600');
  assert.deepStrictEqual(parsed.duplicates, ['max-age']);
  assert.strictEqual(parsed.upstreamView['max-age'], '3600');
  assert.strictEqual(parsed.strictView.get('max-age').value, '60');
  assert.ok(parsed.quirks.some((q) => q.kind === 'duplicate-directive'));
});

test('lower-cases directive names in the strict view', () => {
  const parsed = parseCacheControl('MAX-AGE=60, Public');
  assert.ok(parsed.strictView.has('max-age'));
  assert.ok(parsed.strictView.has('public'));
  // upstream does not lower-case, which is itself worth knowing
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.upstreamView, 'MAX-AGE'));
});

test('bare directive becomes true', () => {
  const parsed = parseCacheControl('no-store');
  assert.strictEqual(parsed.upstreamView['no-store'], true);
  assert.strictEqual(parsed.strictView.get('no-store').value, true);
});

test('value with equals sign keeps only the first pair in upstream view', () => {
  const parsed = parseCacheControl('foo=a=b');
  assert.strictEqual(parsed.upstreamView.foo, 'a');
});

test('splitOutsideQuotes ignores separators inside quotes', () => {
  assert.deepStrictEqual(splitOutsideQuotes('a="x,y",b', ','), ['a="x,y"', 'b']);
  assert.deepStrictEqual(splitOutsideQuotes('a,b', ','), ['a', 'b']);
});

test('field list parsing tolerates whitespace', () => {
  const parsed = parseCacheControl('private=" set-cookie , authorization "');
  assert.deepStrictEqual(parsed.strictView.get('private').fieldList, [
    'set-cookie',
    'authorization',
  ]);
});
