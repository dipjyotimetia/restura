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

  pm.response = {
    to: {
      have: {
        status: function (code) {
          __pmAssert(typeof response !== 'undefined' && response.status === code,
            'Expected status ' + code + ' but got ' + (typeof response !== 'undefined' ? response.status : 'undefined'));
        },
        header: function (key, value) {
          if (typeof response === 'undefined') __pmAssert(false, 'No response available');
          var headers = response.headers || {};
          var got = headers[key];
          if (got === undefined) {
            var lk = String(key).toLowerCase();
            for (var hk in headers) {
              if (Object.prototype.hasOwnProperty.call(headers, hk) && String(hk).toLowerCase() === lk) {
                got = headers[hk]; break;
              }
            }
          }
          __pmAssert(got !== undefined, 'Expected header "' + key + '" to exist');
          if (value !== undefined) {
            __pmAssert(got === value,
              'Expected header "' + key + '" to be "' + value + '" but got "' + got + '"');
          }
        },
        body: function (value) {
          if (typeof response === 'undefined' || response.body === undefined) {
            __pmAssert(false, 'Expected response to have body');
          }
          if (value !== undefined) {
            __pmAssert(__pmDeepEqual(response.body, value),
              'Expected body to be ' + __pmStr(value) + ' but got ' + __pmStr(response.body));
          }
        },
        jsonBody: function (path, value) {
          if (typeof response === 'undefined' || response.body === undefined) {
            __pmAssert(false, 'Expected response to have JSON body');
          }
          if (path) {
            var parts = String(path).split('.');
            var current = response.body;
            for (var i = 0; i < parts.length; i++) {
              if (current === null || typeof current !== 'object') {
                __pmAssert(false, 'Cannot access path ' + path);
              }
              current = current[parts[i]];
            }
            if (value !== undefined) {
              __pmAssert(__pmDeepEqual(current, value),
                'Expected ' + path + ' to be ' + __pmStr(value) + ' but got ' + __pmStr(current));
            }
          }
        }
      },
      be: {
        ok: function () {
          __pmAssert(typeof response !== 'undefined' && response.status >= 200 && response.status < 300,
            'Expected successful status but got ' + (typeof response !== 'undefined' ? response.status : 'undefined'));
        },
        json: function () {
          __pmAssert(typeof response !== 'undefined' && typeof response.body === 'object',
            'Expected response to be JSON');
        },
        html: function () {
          if (typeof response === 'undefined') __pmAssert(false, 'No response available');
          var ct = (response.headers && (response.headers['content-type'] || response.headers['Content-Type'])) || '';
          __pmAssert(String(ct).indexOf('text/html') !== -1, 'Expected response to be HTML');
        }
      }
    },
    time: {
      below: function (ms) {
        __pmAssert(typeof response !== 'undefined' && response.time < ms,
          'Expected response time below ' + ms + 'ms but got ' + (typeof response !== 'undefined' ? response.time : 'undefined') + 'ms');
      }
    },
    /** Postman convenience: returns the parsed JSON body. */
    json: function () {
      if (typeof response === 'undefined') __pmAssert(false, 'No response available');
      if (typeof response.body === 'object' && response.body !== null) return response.body;
      if (typeof response.body === 'string') {
        try { return JSON.parse(response.body); }
        catch (_e) { __pmAssert(false, 'Response body is not valid JSON'); }
      }
      return response.body;
    },
    text: function () {
      if (typeof response === 'undefined') __pmAssert(false, 'No response available');
      if (typeof response.body === 'string') return response.body;
      try { return JSON.stringify(response.body); }
      catch (_e) { return String(response.body); }
    },
    code: undefined, status: undefined, responseTime: undefined
  };
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
})();
`;
