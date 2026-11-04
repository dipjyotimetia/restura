/**
 * Bootstrap script run inside QuickJS after the library bundle is in
 * place. Replaces the legacy hand-rolled chai-subset with the real
 * `require('chai').expect`, then layers the Postman-specific
 * `pm.response.*` convenience assertions on top.
 *
 * The chai library provides `expect / assert / should`. Postman adds
 * `pm.response.to.have.status(...)`, `pm.response.to.have.jsonBody(...)`,
 * `pm.response.to.be.json/html`, `pm.response.time.below(ms)`, and the
 * `pm.response.json()/text()` accessors. None of those are part of chai
 * itself — they're Postman's wrapper around the response global the
 * executor binds per-eval. The helpers below use chai's expect so any
 * assertion text matches a real chai upgrade in the future.
 */
export const PM_EXPECT_BOOTSTRAP = `
(function () {
  var chai = require('chai');
  pm.expect = chai.expect;

  // Tiny assert helper — throws AssertionError so pm.test reports the
  // message verbatim. Postman's response wrappers were historically
  // hand-written this way; reusing chai's assert engine here just to
  // throw a single error would be overkill.
  function __pmAssert(cond, message) {
    if (!cond) {
      var err = new Error(message);
      err.name = 'AssertionError';
      throw err;
    }
  }
  function __pmStr(v) {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    try { return JSON.stringify(v); } catch (_e) { return String(v); }
  }
  function __pmRes() {
    return typeof response !== 'undefined' ? response : undefined;
  }
  function __pmCode() {
    var r = __pmRes();
    return r ? r.status : undefined;
  }
  // The body as text. The app and the CLI hand scripts the raw text; a host
  // that passes an already-parsed value gets it serialised back.
  function __pmText() {
    var r = __pmRes();
    if (!r || r.body === undefined || r.body === null) return '';
    if (typeof r.body === 'string') return r.body;
    try { return JSON.stringify(r.body); } catch (_e) { return String(r.body); }
  }
  // { ok, value }: the body parsed as JSON (a text body is parsed here).
  function __pmJson() {
    var r = __pmRes();
    if (!r) return { ok: false };
    if (r.body !== null && typeof r.body === 'object') return { ok: true, value: r.body };
    if (typeof r.body === 'string') {
      try { return { ok: true, value: JSON.parse(r.body) }; } catch (_e) { return { ok: false }; }
    }
    return { ok: false };
  }
  function __pmHeader(key) {
    var r = __pmRes();
    var headers = (r && r.headers) || {};
    if (headers[key] !== undefined) return headers[key];
    var lk = String(key).toLowerCase();
    for (var hk in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, hk) && String(hk).toLowerCase() === lk) {
        return headers[hk];
      }
    }
    return undefined;
  }
  function __pmDeepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (typeof a !== 'object') return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (!__pmDeepEqual(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }

  // pm.response.to / pm.response.to.not: Postman's chai response assertions.
  // Property assertions (pm.response.to.be.ok;) assert when read, as in chai;
  // reading returns a no-op function so the call form (pm.response.to.be.ok())
  // keeps working. The getters are non-enumerable so logging never trips them.
  function __pmMakeTo(negate) {
    function check(cond, message, negatedMessage) {
      __pmAssert(negate ? !cond : cond, negate ? negatedMessage : message);
    }
    function noop() {}
    function property(target, name, assertion) {
      Object.defineProperty(target, name, {
        get: function () { assertion(); return noop; },
        enumerable: false,
        configurable: true
      });
    }
    function statusIs(label, test) {
      return function () {
        var code = __pmCode();
        check(typeof code === 'number' && test(code),
          'Expected ' + label + ' status but got ' + __pmStr(code),
          'Expected status not to be ' + label + ' but got ' + __pmStr(code));
      };
    }
    var have = {
      status: function (expected) {
        var r = __pmRes();
        var got = typeof expected === 'string' ? (r ? r.statusText : undefined) : __pmCode();
        check(got === expected,
          'Expected status ' + __pmStr(expected) + ' but got ' + __pmStr(got),
          'Expected status not to be ' + __pmStr(expected));
      },
      header: function (key, value) {
        var got = __pmHeader(key);
        if (value === undefined) {
          check(got !== undefined,
            'Expected header "' + key + '" to exist',
            'Expected header "' + key + '" not to exist');
          return;
        }
        // Set-Cookie: also match any single cookie field (Postman HeaderList semantics).
        check(got !== undefined && (got === value || pm.response.headers.has(key, value)),
          got === undefined
            ? 'Expected header "' + key + '" to exist'
            : 'Expected header "' + key + '" to be "' + value + '" but got "' + got + '"',
          'Expected header "' + key + '" not to be "' + value + '"');
      },
      body: function (value) {
        var text = __pmText();
        if (value === undefined) {
          check(text !== '', 'Expected response to have a body', 'Expected response to have no body');
        } else if (value instanceof RegExp) {
          check(value.test(text),
            'Expected body to match ' + String(value), 'Expected body not to match ' + String(value));
        } else if (typeof value === 'string') {
          check(text === value,
            'Expected body to be ' + __pmStr(value) + ' but got ' + __pmStr(text),
            'Expected body not to be ' + __pmStr(value));
        } else {
          var parsed = __pmJson();
          check(parsed.ok && __pmDeepEqual(parsed.value, value),
            'Expected body to be ' + __pmStr(value) + ' but got ' + __pmStr(text),
            'Expected body not to be ' + __pmStr(value));
        }
      },
      jsonBody: function (path, value) {
        var parsed = __pmJson();
        if (!parsed.ok) {
          // Not JSON: fails both ways, as Postman's jsonBody does.
          __pmAssert(false, 'Expected response to have a JSON body');
          return;
        }
        if (path === undefined) {
          check(true, '', 'Expected response not to have a JSON body');
          return;
        }
        if (typeof path !== 'string') {
          check(__pmDeepEqual(parsed.value, path),
            'Expected JSON body to be ' + __pmStr(path), 'Expected JSON body not to be ' + __pmStr(path));
          return;
        }
        var parts = path.split('.');
        var current = parsed.value;
        var found = true;
        for (var i = 0; i < parts.length; i++) {
          if (current === null || typeof current !== 'object' ||
              !Object.prototype.hasOwnProperty.call(current, parts[i])) {
            found = false;
            break;
          }
          current = current[parts[i]];
        }
        if (value === undefined) {
          check(found, 'Expected JSON body to have "' + path + '"',
            'Expected JSON body not to have "' + path + '"');
        } else {
          check(found && __pmDeepEqual(current, value),
            'Expected ' + path + ' to be ' + __pmStr(value) + ' but got ' + __pmStr(found ? current : undefined),
            'Expected ' + path + ' not to be ' + __pmStr(value));
        }
      }
    };
    var be = {};
    property(be, 'ok', statusIs('a successful (2xx)', function (c) { return c >= 200 && c < 300; }));
    property(be, 'success', statusIs('a successful (2xx)', function (c) { return Math.floor(c / 100) === 2; }));
    property(be, 'info', statusIs('an informational (1xx)', function (c) { return Math.floor(c / 100) === 1; }));
    property(be, 'redirection', statusIs('a redirection (3xx)', function (c) { return Math.floor(c / 100) === 3; }));
    property(be, 'clientError', statusIs('a client error (4xx)', function (c) { return Math.floor(c / 100) === 4; }));
    property(be, 'serverError', statusIs('a server error (5xx)', function (c) { return Math.floor(c / 100) === 5; }));
    property(be, 'error', statusIs('an error (4xx/5xx)', function (c) { return c >= 400; }));
    property(be, 'accepted', statusIs('202', function (c) { return c === 202; }));
    property(be, 'badRequest', statusIs('400', function (c) { return c === 400; }));
    property(be, 'unauthorized', statusIs('401', function (c) { return c === 401; }));
    property(be, 'forbidden', statusIs('403', function (c) { return c === 403; }));
    property(be, 'notFound', statusIs('404', function (c) { return c === 404; }));
    property(be, 'rateLimited', statusIs('429', function (c) { return c === 429; }));
    property(be, 'json', function () {
      var parsed = __pmJson();
      check(parsed.ok && parsed.value !== null && typeof parsed.value === 'object',
        'Expected response to be JSON', 'Expected response not to be JSON');
    });
    property(be, 'html', function () {
      var ct = __pmHeader('content-type') || '';
      check(String(ct).indexOf('text/html') !== -1,
        'Expected response to be HTML', 'Expected response not to be HTML');
    });
    property(be, 'withBody', function () {
      check(__pmText() !== '', 'Expected response to have a body', 'Expected response to have no body');
    });
    return { have: have, be: be };
  }

  pm.response = {
    to: __pmMakeTo(false),
    time: {
      below: function (ms) {
        __pmAssert(typeof response !== 'undefined' && response.time < ms,
          'Expected response time below ' + ms + 'ms but got ' + (typeof response !== 'undefined' ? response.time : 'undefined') + 'ms');
      }
    },
    /** Postman convenience: returns the parsed JSON body. */
    json: function () {
      if (typeof response === 'undefined') __pmAssert(false, 'No response available');
      var parsed = __pmJson();
      if (!parsed.ok) __pmAssert(false, 'Response body is not valid JSON');
      return parsed.value;
    },
    text: function () {
      if (typeof response === 'undefined') __pmAssert(false, 'No response available');
      return __pmText();
    },
  };
  pm.response.to.not = __pmMakeTo(true);
  // Top-level shortcuts populated lazily from the bound response global.
  Object.defineProperty(pm.response, 'code', { get: function () {
    return typeof response !== 'undefined' ? response.status : undefined;
  } });
  Object.defineProperty(pm.response, 'status', { get: function () {
    return typeof response !== 'undefined' ? response.statusText : undefined;
  } });
  Object.defineProperty(pm.response, 'responseTime', { get: function () {
    return typeof response !== 'undefined' ? response.time : undefined;
  } });
  // gRPC rich error details (google.rpc.Status) — [] when none / non-gRPC.
  Object.defineProperty(pm.response, 'statusDetails', { get: function () {
    return typeof response !== 'undefined' && response.statusDetails ? response.statusDetails : [];
  } });

  // pm.response.headers — Postman HeaderList subset. get() returns the flat
  // value (Set-Cookie = every cookie joined with ", "); all()/each() yield one
  // row per Set-Cookie field. The executor normalises response.headers and
  // response.setCookies identically on every harness.
  function __pmHeaderRows() {
    if (typeof response === 'undefined') return [];
    var rows = [];
    var headers = response.headers || {};
    var cookies = response.setCookies || [];
    for (var k in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
      if (String(k).toLowerCase() === 'set-cookie' && cookies.length) {
        for (var i = 0; i < cookies.length; i++) rows.push({ key: k, value: cookies[i] });
      } else {
        rows.push({ key: k, value: headers[k] });
      }
    }
    return rows;
  }
  pm.response.headers = {
    get: function (key) {
      var headers = typeof response !== 'undefined' ? response.headers || {} : {};
      var lk = String(key).toLowerCase();
      for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k) && String(k).toLowerCase() === lk) {
          return headers[k];
        }
      }
      return undefined;
    },
    has: function (key, value) {
      var lk = String(key).toLowerCase();
      if (value === undefined) return pm.response.headers.get(key) !== undefined;
      if (pm.response.headers.get(key) === value) return true;
      return __pmHeaderRows().some(function (row) {
        return String(row.key).toLowerCase() === lk && row.value === value;
      });
    },
    all: function () { return __pmHeaderRows(); },
    each: function (fn) { __pmHeaderRows().forEach(fn); },
    toObject: function () {
      var out = {};
      var headers = typeof response !== 'undefined' ? response.headers || {} : {};
      for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k)) out[k] = headers[k];
      }
      return out;
    },
  };

  // gRPC: pm.response.metadata is the initial (header) metadata — an alias of
  // pm.response.headers — and pm.response.trailers the trailing metadata
  // (grpc-status etc.). Both read the bound response global, so they are
  // empty maps for protocols without trailers (#910).
  pm.response.metadata = pm.response.headers;
  function __pmTrailers() {
    return typeof response !== 'undefined' && response.trailers ? response.trailers : {};
  }
  pm.response.trailers = {
    get: function (key) {
      var trailers = __pmTrailers();
      var lk = String(key).toLowerCase();
      for (var k in trailers) {
        if (Object.prototype.hasOwnProperty.call(trailers, k) && String(k).toLowerCase() === lk) {
          return trailers[k];
        }
      }
      return undefined;
    },
    has: function (key, value) {
      var got = pm.response.trailers.get(key);
      return value === undefined ? got !== undefined : got === value;
    },
    all: function () {
      var trailers = __pmTrailers();
      var rows = [];
      for (var k in trailers) {
        if (Object.prototype.hasOwnProperty.call(trailers, k)) rows.push({ key: k, value: trailers[k] });
      }
      return rows;
    },
    each: function (fn) { pm.response.trailers.all().forEach(fn); },
    toObject: function () {
      var out = {};
      var trailers = __pmTrailers();
      for (var k in trailers) {
        if (Object.prototype.hasOwnProperty.call(trailers, k)) out[k] = trailers[k];
      }
      return out;
    },
  };

  // gRPC streams: pm.response.messages over the retained inbound messages (parsed;
  // the renderer keeps the most recent ones — see streamRetention.ts),
  // collected before the test script runs (#917). Empty for single responses.
  function __pmMessages() {
    return typeof response !== 'undefined' && Array.isArray(response.messages)
      ? response.messages.slice()
      : [];
  }
  pm.response.messages = {
    all: function () { return __pmMessages(); },
    count: function () { return __pmMessages().length; },
    idx: function (i) { return __pmMessages()[i]; },
    each: function (fn) { __pmMessages().forEach(fn); },
    toJSON: function () { return __pmMessages(); },
  };

  // pm.response.cookies — Postman CookieList subset over the response's own
  // Set-Cookie fields (pm.cookies is the jar). Later fields win on name clash.
  function __pmResponseCookies() {
    return typeof response !== 'undefined' && response.cookies ? response.cookies.slice() : [];
  }
  pm.response.cookies = {
    all: function () { return __pmResponseCookies(); },
    toJSON: function () { return __pmResponseCookies(); },
    each: function (fn) { __pmResponseCookies().forEach(fn); },
    get: function (name) {
      var all = __pmResponseCookies();
      for (var i = all.length - 1; i >= 0; i--) if (all[i].name === name) return all[i].value;
      return undefined;
    },
    has: function (name) { return pm.response.cookies.get(name) !== undefined; },
    toObject: function () {
      var out = {};
      __pmResponseCookies().forEach(function (c) { out[c.name] = c.value; });
      return out;
    },
  };
})();
`;
