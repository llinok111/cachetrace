'use strict';

/**
 * Input normalisation.
 *
 * Three shapes are accepted because that is what actually reaches a person
 * debugging cache behaviour: a HAR export from DevTools, a stream of NDJSON
 * produced by a test harness, or a hand-written JSON fixture.
 *
 * HAR deserves a note. Its headers are `[{name, value}]` arrays, and it records
 * the URL but not always a Host header. Upstream reads `headers.host` and
 * compares it against the stored value, so a HAR entry without Host would compare
 * `undefined === undefined` and appear to match anything. Host is therefore
 * derived from the URL when absent, and `derivedHost` records that it happened.
 */

/**
 * @param {Array<{name:string, value:string}>|Record<string,string>|undefined} headers
 * @param {string} [url]
 * @returns {{headers: Record<string,string>, derivedHost: boolean}}
 */
function headersFrom(headers, url) {
  /** @type {Record<string,string>} */
  const out = {};

  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (!header || typeof header.name !== 'string') continue;
      const name = header.name;
      if (name.startsWith(':')) continue; // HTTP/2 pseudo-headers
      out[name] = header.value;
    }
  } else if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      out[key] = headers[key];
    }
  }

  let derivedHost = false;
  const hasHost = Object.keys(out).some((k) => k.toLowerCase() === 'host');
  if (!hasHost && url) {
    try {
      out.host = new URL(url).host;
      derivedHost = true;
    } catch (error) {
      /* leave absent */
    }
  }

  return { headers: out, derivedHost };
}

/**
 * @param {Object} harEntry
 * @returns {Object}
 */
function entryFromHAR(harEntry) {
  const req = harEntry.request || {};
  const res = harEntry.response || {};
  const url = req.url;
  const reqHeaders = headersFrom(req.headers, url);
  const resHeaders = headersFrom(res.headers);
  return {
    id: harEntry._cachetraceId || url,
    url,
    request: {
      url,
      method: req.method || 'GET',
      headers: reqHeaders.headers,
    },
    response: {
      status: res.status === undefined ? 200 : res.status,
      headers: resHeaders.headers,
    },
    derivedHost: reqHeaders.derivedHost,
    source: 'har',
  };
}

/**
 * @param {Object} raw
 * @param {number} index
 * @returns {Object}
 */
function entryFromGeneric(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError(`entry ${index} is not an object`);
  }
  if (!raw.request || !raw.response) {
    throw new TypeError(`entry ${index} needs both request and response`);
  }
  const url = raw.url || raw.request.url;
  const reqHeaders = headersFrom(raw.request.headers, url);
  const resHeaders = headersFrom(raw.response.headers);
  return {
    id: raw.id || url || `entry-${index}`,
    url,
    request: {
      url,
      method: raw.request.method || 'GET',
      headers: reqHeaders.headers,
    },
    response: {
      status: raw.response.status === undefined ? 200 : raw.response.status,
      headers: resHeaders.headers,
    },
    options: raw.options,
    ageSeconds: raw.ageSeconds,
    derivedHost: reqHeaders.derivedHost,
    source: 'json',
  };
}

/**
 * @param {string} text
 * @returns {Object[]}
 */
function parseHAR(text) {
  const parsed = typeof text === 'string' ? JSON.parse(text) : text;
  const entries = parsed && parsed.log && parsed.log.entries;
  if (!Array.isArray(entries)) {
    throw new TypeError('not a HAR: expected log.entries[]');
  }
  return entries.map((e) => entryFromHAR(e));
}

/**
 * @param {string} text
 * @returns {Object[]}
 */
function parseNDJSON(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new TypeError(`NDJSON line ${i + 1} is not valid JSON: ${error.message}`);
    }
    out.push(entryFromGeneric(parsed, i));
  });
  return out;
}

/**
 * Accept a HAR object, an NDJSON string, a JSON string, an array of entries, or a
 * single entry, and return a uniform array.
 * @param {*} source
 * @returns {Object[]}
 */
function normalizeEntries(source) {
  if (source == null) throw new TypeError('no input given');

  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (!trimmed) throw new TypeError('input is empty');
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        // Fall through to NDJSON: a multi-line stream is not a single document.
        return parseNDJSON(source);
      }
      return normalizeEntries(parsed);
    }
    return parseNDJSON(source);
  }

  if (Array.isArray(source)) {
    return source.map((raw, i) => (raw && raw.log ? entryFromHAR(raw) : entryFromGeneric(raw, i)));
  }

  if (source.log && Array.isArray(source.log.entries)) {
    return source.log.entries.map((e) => entryFromHAR(e));
  }

  if (source.request && source.response) {
    return [entryFromGeneric(source, 0)];
  }

  throw new TypeError(
    'unrecognised input: expected a HAR object, an array of entries, or NDJSON text'
  );
}

module.exports = {
  normalizeEntries,
  parseHAR,
  parseNDJSON,
  headersFrom,
  entryFromHAR,
  entryFromGeneric,
};
