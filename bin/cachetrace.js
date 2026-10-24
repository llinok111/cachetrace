#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  explain,
  audit,
  counterfactual,
  renderText,
  renderMarkdown,
  renderAuditText,
  renderAuditMarkdown,
  renderCounterfactualText,
  renderCounterfactualMarkdown,
  normalizeEntries,
} = require('../lib/index');

const VERSION = require('../package.json').version;

const HELP = `cachetrace ${VERSION}

Explain and audit HTTP cache decisions with the same engine your CDN runs.

USAGE
  cachetrace explain <file|-> [options]
  cachetrace audit   <file|-> [options]

INPUT
  <file>   a HAR export, a JSON file with { request, response } entries,
           an array of such entries, or newline-delimited JSON
  -        read from stdin

EXPLAIN OPTIONS
  --index <n>          which entry to explain when the input has several (default 0)
  --age <seconds>      how long the response has already been sitting in a cache
  --shared             treat the cache as shared (default)
  --private            treat the cache as a browser-private cache
  --counterfactual     also list single-header changes that flip the verdict
  --format <fmt>       text (default) | md | json

AUDIT OPTIONS
  --limit <n>          how many entries get counterfactual analysis (default 200)
  --rows               include a per-entry table
  --format <fmt>       text (default) | md | json

COMMON OPTIONS
  --fail-on <level>    exit non-zero on: divergence | warning | critical (for CI)
  --now <epoch-ms>     pin the evaluation instant (reproducible output)
  --help, -h
  --version, -v

EXAMPLES
  cachetrace explain response.json
  cachetrace explain site.har --index 3 --counterfactual
  cat capture.ndjson | cachetrace audit - --format md > report.md
  cachetrace audit site.har --fail-on critical
`;

/**
 * @param {string[]} argv
 * @returns {{command: string, target: string, flags: Object}}
 */
function parseArgs(argv) {
  const args = { command: null, target: null, flags: {} };
  const rest = argv.slice();
  while (rest.length) {
    const token = rest.shift();
    if (token === '--help' || token === '-h') {
      args.flags.help = true;
      continue;
    }
    if (token === '--version' || token === '-v') {
      args.flags.version = true;
      continue;
    }
    if (token === '--shared') {
      args.flags.shared = true;
      continue;
    }
    if (token === '--private') {
      args.flags.shared = false;
      continue;
    }
    if (token === '--counterfactual') {
      args.flags.counterfactual = true;
      continue;
    }
    if (token === '--rows') {
      args.flags.rows = true;
      continue;
    }
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const value = rest.shift();
      if (value === undefined) throw new Error(`missing value for --${name}`);
      args.flags[name] = value;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new Error(`unknown option ${token}`);
    }
    if (!args.command) args.command = token;
    else if (!args.target) args.target = token;
    else throw new Error(`unexpected argument ${token}`);
  }
  return args;
}

/**
 * @param {string} target
 * @returns {string}
 */
function readInput(target) {
  if (!target) throw new Error('no input given; pass a file path or - for stdin');
  if (target === '-') return fs.readFileSync(0, 'utf8');
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) throw new Error(`file not found: ${resolved}`);
  return fs.readFileSync(resolved, 'utf8');
}

/**
 * @param {Object} flags
 * @returns {Object}
 */
function commonOptions(flags) {
  const opts = {};
  if (flags['now'] !== undefined) {
    const now = Number(flags['now']);
    if (!Number.isFinite(now)) throw new Error('--now must be an epoch timestamp in ms');
    opts.now = now;
  }
  if (flags.shared !== undefined) opts.shared = flags.shared;
  return opts;
}

/**
 * @param {Object} explained
 * @returns {boolean}
 */
function hasCritical(explained) {
  return explained.risks.some((r) => r.severity === 'critical');
}

/**
 * @param {Object} result
 * @returns {boolean}
 */
function auditHasCritical(result) {
  return result.findings.some((f) => f.severity === 'critical');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${HELP}`);
    return 1;
  }

  if (args.flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!args.command) {
    process.stdout.write(HELP);
    return 1;
  }
  if (args.command !== 'explain' && args.command !== 'audit') {
    process.stderr.write(`error: unknown command "${args.command}"\n\n${HELP}`);
    return 1;
  }

  const format = args.flags.format || 'text';
  if (!['text', 'md', 'json'].includes(format)) {
    process.stderr.write(`error: unknown --format ${format}\n`);
    return 1;
  }

  try {
    const text = readInput(args.target);
    const base = commonOptions(args.flags);

    if (args.command === 'explain') {
      const entries = normalizeEntries(text);
      if (!entries.length) throw new Error('input contains no entries');
      const index = args.flags.index === undefined ? 0 : Number(args.flags.index);
      if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
        throw new Error(
          `--index ${args.flags.index} out of range; input has ${entries.length} entr${
            entries.length === 1 ? 'y' : 'ies'
          }`
        );
      }
      const entry = entries[index];
      let ageSeconds = 0;
      if (args.flags.age !== undefined) {
        ageSeconds = Number(args.flags.age);
        if (!Number.isFinite(ageSeconds) || ageSeconds < 0) {
          throw new Error('--age must be a non-negative number of seconds');
        }
      }
      const explained = explain(entry, Object.assign({}, base, { ageSeconds }));

      let cf = null;
      if (args.flags.counterfactual) {
        cf = counterfactual(entry, {
          now: explained.clock.now,
          responseTime: explained.clock.responseTime,
        });
      }

      if (format === 'json') {
        process.stdout.write(
          JSON.stringify(cf ? { explanation: serialize(explained), counterfactual: cf } : serialize(explained), null, 2) + '\n'
        );
      } else if (format === 'md') {
        process.stdout.write(renderMarkdown(explained) + '\n');
        if (cf) process.stdout.write('\n' + renderCounterfactualMarkdown(cf) + '\n');
      } else {
        process.stdout.write(renderText(explained) + '\n');
        if (cf) process.stdout.write('\n' + renderCounterfactualText(cf) + '\n');
      }

      if (args.flags['fail-on']) {
        const level = args.flags['fail-on'];
        if (level === 'divergence' && !explained.consistent) return 2;
        if (level === 'critical' && hasCritical(explained)) return 3;
        if (level === 'warning' && explained.risks.length) return 3;
      }
      return 0;
    }

    if (args.command === 'audit') {
      let limit = 200;
      if (args.flags.limit !== undefined) {
        limit = Number(args.flags.limit);
        if (!Number.isInteger(limit) || limit < 0) {
          throw new Error('--limit must be a non-negative integer');
        }
      }
      const result = audit(text, Object.assign({}, base, {
        counterfactualLimit: limit,
        includeEntries: !!args.flags.rows,
      }));

      if (format === 'json') {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (format === 'md') {
        process.stdout.write(renderAuditMarkdown(result) + '\n');
      } else {
        process.stdout.write(renderAuditText(result) + '\n');
      }

      if (args.flags['fail-on']) {
        const level = args.flags['fail-on'];
        if (level === 'divergence' && result.divergenceCount > 0) return 2;
        if (level === 'critical' && auditHasCritical(result)) return 3;
        if (level === 'warning' && result.findings.length) return 3;
      }
      return 0;
    }

    return 1;
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 1;
  }
}

/**
 * Strip the non-serialisable state object before writing JSON.
 * @param {Object} explained
 * @returns {Object}
 */
function serialize(explained) {
  const clone = Object.assign({}, explained);
  clone.state = {
    now: explained.state.now,
    responseTime: explained.state.responseTime,
    isShared: explained.state.isShared,
    status: explained.state.status,
    method: explained.state.method,
    url: explained.state.url,
    host: explained.state.host,
  };
  return clone;
}

process.exitCode = main();
