'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'cachetrace.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const NOW = '1792826880000';

/**
 * @param {string[]} args
 * @param {Object} [opts]
 * @returns {{status:number, stdout:string, stderr:string}}
 */
function run(args, opts = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input: opts.input,
    timeout: 30000,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test('--help prints usage and exits zero', () => {
  const r = run(['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /USAGE/);
  assert.match(r.stdout, /cachetrace explain/);
});

test('--version prints a semver', () => {
  const r = run(['--version']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('explain prints verdict, trace and no divergence', () => {
  const r = run(['explain', path.join(FIXTURES, 'immutable.json'), '--now', NOW]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /storable=true/);
  assert.match(r.stdout, /reuse=true/);
  assert.match(r.stdout, /replay agrees with http-cache-semantics/);
  assert.match(r.stdout, /DECISION TRACE/);
});

test('explain --format json is machine readable', () => {
  const r = run(['explain', path.join(FIXTURES, 'dead-entry.json'), '--now', NOW, '--format', 'json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.verdict.storable, true);
  assert.strictEqual(parsed.verdict.reuse, false);
  assert.ok(parsed.risks.some((x) => x.code === 'dead-cache-entry'));
  assert.ok(parsed.traces.storable.children.length > 0);
});

test('explain --format md renders a table', () => {
  const r = run(['explain', path.join(FIXTURES, 'cookie-blocked.json'), '--now', NOW, '--format', 'md']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\| field \| value \|/);
  assert.match(r.stdout, /set-cookie-blocks-shared-freshness/);
});

test('explain --counterfactual lists verified changes', () => {
  const r = run([
    'explain',
    path.join(FIXTURES, 'cookie-blocked.json'),
    '--now',
    NOW,
    '--counterfactual',
  ]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /counterfactual analysis/);
  assert.match(r.stdout, /verified:/);
  assert.match(r.stdout, /\[risk: (low|medium|high)\]/);
});

test('audit reads a HAR from a file', () => {
  const r = run(['audit', path.join(FIXTURES, 'site.har'), '--now', NOW]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /entries\s+9/);
  assert.match(r.stdout, /dead-cache-entry/);
  assert.match(r.stdout, /RECOMMENDATIONS/);
});

test('audit accepts NDJSON on stdin', () => {
  const ndjson = JSON.stringify({
    url: 'https://stdin.test/a',
    request: { method: 'GET', headers: {} },
    response: { status: 200, headers: { 'cache-control': 'max-age=60' } },
  });
  const r = run(['audit', '-', '--now', NOW], { input: ndjson });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /entries\s+1/);
});

test('--fail-on critical returns 3 when a dead entry is present', () => {
  const critical = run(['audit', path.join(FIXTURES, 'site.har'), '--now', NOW, '--fail-on', 'critical']);
  assert.strictEqual(critical.status, 3);

  const clean = run(['explain', path.join(FIXTURES, 'immutable.json'), '--now', NOW, '--fail-on', 'critical']);
  assert.strictEqual(clean.status, 0);
});

test('a missing file exits 1 with a clear message', () => {
  const r = run(['explain', path.join(FIXTURES, 'nope.json')]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /file not found/);
});

test('an out-of-range index exits 1 and says how many entries exist', () => {
  const r = run(['explain', path.join(FIXTURES, 'site.har'), '--index', '99', '--now', NOW]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /out of range/);
  assert.match(r.stderr, /9 entries/);
});

test('malformed NDJSON exits 1 and names the line', () => {
  const r = run(['audit', '-', '--now', NOW], { input: '{"bad": true}\n' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unrecognised input/);
});

test('an unknown command exits 1', () => {
  const r = run(['frobnicate', 'x']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown command/);
});
