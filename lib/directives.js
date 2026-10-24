'use strict';

/**
 * Cache-Control parsing, carried out twice on purpose.
 *
 * `upstreamView` reproduces the algorithm used by http-cache-semantics 4.3.0
 * verbatim (comma split with no quote awareness, last duplicate wins). That
 * view is what the real decision engine will act on, so it is the one the
 * replay must agree with.
 *
 * `strictView` is a quote-aware parse that keeps duplicate occurrences and
 * field-name lists. Wherever the two disagree, the difference is a place where
 * a header that *looks* correct to a human is interpreted differently by the
 * engine. cachetrace reports those differences instead of silently picking one.
 */

/**
 * Split on `sep` while ignoring separators inside double-quoted strings.
 * @param {string} input
 * @param {string} sep single character separator
 * @returns {string[]}
 */
function splitOutsideQuotes(input, sep) {
  const out = [];
  let buf = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && input[i - 1] !== '\\') {
      quoted = !quoted;
      buf += ch;
      continue;
    }
    if (ch === sep && !quoted) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/**
 * Split a directive on the first `=` that sits outside quotes.
 * @param {string} input
 * @returns {[string, string|undefined]}
 */
function splitFirstEquals(input) {
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && input[i - 1] !== '\\') {
      quoted = !quoted;
      continue;
    }
    if (ch === '=' && !quoted) {
      return [input.slice(0, i), input.slice(i + 1)];
    }
  }
  return [input, undefined];
}

/**
 * Strip one layer of surrounding double quotes.
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a comma-separated field-name list as used by `no-cache="a, b"` and
 * `private="c"`. Returns null when the directive carries no list.
 * @param {string|undefined} value
 * @returns {string[]|null}
 */
function parseFieldList(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return null;
  const inner = unquote(trimmed);
  const fields = inner
    .split(',')
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);
  return fields.length ? fields : null;
}

/**
 * @typedef {Object} DirectiveEntry
 * @property {string} name lower-cased directive name
 * @property {string|true} value raw value, `true` for bare directives
 * @property {string[]|null} fieldList parsed field-name list, if any
 * @property {number} index position among parsed parts
 */

/**
 * @typedef {Object} ParsedCacheControl
 * @property {string|null} source raw header value
 * @property {Record<string, string|true>} upstreamView exactly what upstream would build
 * @property {Map<string, DirectiveEntry>} strictView first occurrence wins, field lists kept
 * @property {string[]} duplicates names that appeared more than once
 * @property {Object[]} quirks disagreements or spec-relevant oddities
 */

/**
 * @param {string|undefined|null} header raw Cache-Control value
 * @returns {ParsedCacheControl}
 */
function parseCacheControl(header) {
  /** @type {Record<string, string|true>} */
  const upstreamView = {};
  /** @type {Map<string, DirectiveEntry>} */
  const strictView = new Map();
  /** @type {string[]} */
  const duplicates = [];
  /** @type {Object[]} */
  const quirks = [];

  if (!header || typeof header !== 'string') {
    return {
      source: header == null ? null : String(header),
      upstreamView,
      strictView,
      duplicates,
      quirks,
    };
  }

  // --- upstream algorithm, reproduced exactly -----------------------------
  // header.trim().split(/,/) then part.split(/=/, 2), value quote-stripped,
  // later duplicates overwrite earlier ones.
  const upstreamParts = header.trim().split(/,/);
  for (const part of upstreamParts) {
    const [k, v] = part.split(/=/, 2);
    if (k === undefined) continue;
    upstreamView[k.trim()] = v === undefined ? true : v.trim().replace(/^"|"$/g, '');
  }

  // --- quote-aware parse --------------------------------------------------
  const strictParts = splitOutsideQuotes(header, ',');
  let index = 0;
  for (const part of strictParts) {
    const rawPart = part.trim();
    if (!rawPart) {
      index++;
      continue;
    }
    const [rawName, rawValue] = splitFirstEquals(rawPart);
    const name = rawName.trim().toLowerCase();
    if (!name) {
      index++;
      continue;
    }
    const value = rawValue === undefined ? true : unquote(rawValue.trim());
    const writtenName = rawName.trim();
    if (writtenName !== name) {
      quirks.push({
        kind: 'mixed-case-directive',
        name,
        detail:
          `The directive is written as "${writtenName}". RFC 9111 §5.2 makes directive names ` +
          `case-insensitive, but the engine keys on the exact text, so "${writtenName}" is ` +
          'stored as its own directive and never matched as "' + name + '".',
      });
    }
    if (strictView.has(name)) {
      if (!duplicates.includes(name)) duplicates.push(name);
      quirks.push({
        kind: 'duplicate-directive',
        name,
        detail:
          'RFC 9111 §4.2.1 treats a repeated directive as invalid freshness information; ' +
          'upstream silently keeps the last occurrence.',
      });
      index++;
      continue;
    }
    strictView.set(name, {
      name,
      value,
      fieldList: parseFieldList(rawValue),
      index,
    });
    index++;
  }

  // --- where do the two views disagree? -----------------------------------
  const upstreamNames = Object.keys(upstreamView).map((n) => n.trim().toLowerCase());
  for (const name of strictView.keys()) {
    if (!upstreamNames.includes(name)) {
      quirks.push({
        kind: 'lost-directive',
        name,
        detail:
          'The strict parse found this directive but upstream did not, usually because a ' +
          'quoted value contained a comma.',
      });
    }
  }
  for (const name of upstreamNames) {
    if (!strictView.has(name)) {
      quirks.push({
        kind: 'phantom-directive',
        name,
        detail:
          'Upstream produced this directive from a comma inside a quoted value; it does not ' +
          'exist in the header as written.',
      });
    }
  }

  // A quoted comma inside a value is always worth surfacing: it is the one
  // construct where the two parsers can diverge in a way that changes meaning.
  if (/"[^"]*,[^"]*"/.test(header)) {
    quirks.push({
      kind: 'quoted-comma',
      name: null,
      detail:
        'A quoted value contains a comma. Upstream splits on every comma, so the resulting ' +
        'directive set may not match the header as written.',
    });
  }

  return {
    source: header,
    upstreamView,
    strictView,
    duplicates,
    quirks,
  };
}

/**
 * Rewrite a Cache-Control value with every directive name lower-cased, keeping
 * values and order untouched. RFC 9111 makes directive names case-insensitive,
 * so this is a semantics-preserving repair for an engine that keys on exact text.
 * @param {string} header
 * @returns {string}
 */
function lowercaseDirectiveNames(header) {
  if (typeof header !== 'string') return header;
  return splitOutsideQuotes(header, ',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return '';
      const [name, value] = splitFirstEquals(trimmed);
      const lowered = name.trim().toLowerCase();
      return value === undefined ? lowered : `${lowered}=${value.trim()}`;
    })
    .filter(Boolean)
    .join(', ');
}

module.exports = {
  parseCacheControl,
  splitOutsideQuotes,
  splitFirstEquals,
  unquote,
  parseFieldList,
  lowercaseDirectiveNames,
};
