/**
 * Chai-style assertion subset for the QuickJS sandbox.
 *
 * Restura's pre-request and test scripts run inside QuickJS WASM (see
 * scriptExecutor.ts and ADR-0004). The body of `pm.expect()` is evaluated
 * inside the sandbox as plain JavaScript — we cannot bind a native
 * implementation because the assertion API needs to support fluent
 * chaining (`expect(x).to.be.an('object')`) which is hard to bridge from
 * native callbacks.
 *
 * This module exports the JS source code that's evaluated once at sandbox
 * setup. Keeping it in a separate file (rather than inlined in
 * scriptExecutor.ts) makes the assertion surface easy to audit, test in
 * isolation by evaluating the source against a real JS engine, and extend
 * without touching the executor.
 *
 * Postman-compatibility goal: the subset below supports the assertions
 * that appear in 95%+ of real-world Postman test scripts as observed in
 * the Postman public collection corpus. Notable omissions:
 *   - `.that.is.<predicate>` linking words — supported via `.to.<predicate>`
 *     and `.and.<predicate>`; the plain `.is.` link word is not aliased.
 *   - Custom plugins (`.using`, `chai.use`) — out of scope.
 *   - Object schema validation (`tv4`) — handled by the contracts feature.
 */

export const PM_EXPECT_CODE = `
  // ---------------------------------------------------------------------------
  // Chai-style fluent assertion builder
  // ---------------------------------------------------------------------------
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
    if (typeof v === 'string') return JSON.stringify(v);
    try { return JSON.stringify(v); } catch (_e) { return String(v); }
  }

  function __pmTypeOf(v) {
    if (Array.isArray(v)) return 'array';
    if (v === null) return 'null';
    return typeof v;
  }

  function __pmDeepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (typeof a !== 'object') return false;
    var aIsArr = Array.isArray(a), bIsArr = Array.isArray(b);
    if (aIsArr !== bIsArr) return false;
    if (aIsArr) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (!__pmDeepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    var ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (var i = 0; i < ak.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ak[i])) return false;
      if (!__pmDeepEqual(a[ak[i]], b[ak[i]])) return false;
    }
    return true;
  }

  function __pmIncludes(haystack, needle) {
    if (typeof haystack === 'string') {
      return typeof needle === 'string' && haystack.indexOf(needle) !== -1;
    }
    if (Array.isArray(haystack)) {
      for (var i = 0; i < haystack.length; i++) {
        if (__pmDeepEqual(haystack[i], needle)) return true;
      }
      return false;
    }
    if (haystack && typeof haystack === 'object' && needle && typeof needle === 'object') {
      var keys = Object.keys(needle);
      for (var i = 0; i < keys.length; i++) {
        if (!__pmDeepEqual(haystack[keys[i]], needle[keys[i]])) return false;
      }
      return true;
    }
    return false;
  }

  function __pmChain(actual, negated) {
    var ctx = { actual: actual, negated: !!negated };
    function flip(cond) { return ctx.negated ? !cond : cond; }
    function assertCond(cond, posMsg, negMsg) {
      __pmAssert(flip(cond), ctx.negated ? negMsg : posMsg);
      return chain;
    }

    var chain = {};

    // Boolean/type predicates -------------------------------------------------
    var be = {
      a: function(type) {
        var t = __pmTypeOf(ctx.actual);
        return assertCond(t === String(type).toLowerCase(),
          'Expected type ' + type + ' but got ' + t,
          'Expected type not to be ' + type);
      },
      an: function(type) { return be.a(type); },
      'true': function() {
        return assertCond(ctx.actual === true,
          'Expected true but got ' + __pmStr(ctx.actual),
          'Expected value not to be true');
      },
      'false': function() {
        return assertCond(ctx.actual === false,
          'Expected false but got ' + __pmStr(ctx.actual),
          'Expected value not to be false');
      },
      'null': function() {
        return assertCond(ctx.actual === null,
          'Expected null but got ' + __pmStr(ctx.actual),
          'Expected value not to be null');
      },
      undefined: function() {
        return assertCond(ctx.actual === undefined,
          'Expected undefined but got ' + __pmStr(ctx.actual),
          'Expected value not to be undefined');
      },
      empty: function() {
        var a = ctx.actual;
        var isEmpty =
          a === undefined || a === null ||
          (typeof a === 'string' && a.length === 0) ||
          (Array.isArray(a) && a.length === 0) ||
          (typeof a === 'object' && Object.keys(a).length === 0);
        return assertCond(isEmpty,
          'Expected empty but got ' + __pmStr(a),
          'Expected non-empty value');
      },
      ok: function() {
        return assertCond(!!ctx.actual,
          'Expected truthy but got ' + __pmStr(ctx.actual),
          'Expected falsy value');
      },
      above: function(n) {
        return assertCond(ctx.actual > n,
          'Expected ' + __pmStr(ctx.actual) + ' to be above ' + n,
          'Expected ' + __pmStr(ctx.actual) + ' not to be above ' + n);
      },
      below: function(n) {
        return assertCond(ctx.actual < n,
          'Expected ' + __pmStr(ctx.actual) + ' to be below ' + n,
          'Expected ' + __pmStr(ctx.actual) + ' not to be below ' + n);
      },
      at: {
        least: function(n) {
          return assertCond(ctx.actual >= n,
            'Expected ' + __pmStr(ctx.actual) + ' to be at least ' + n,
            'Expected ' + __pmStr(ctx.actual) + ' not to be at least ' + n);
        },
        most: function(n) {
          return assertCond(ctx.actual <= n,
            'Expected ' + __pmStr(ctx.actual) + ' to be at most ' + n,
            'Expected ' + __pmStr(ctx.actual) + ' not to be at most ' + n);
        },
      },
      within: function(min, max) {
        return assertCond(ctx.actual >= min && ctx.actual <= max,
          'Expected ' + __pmStr(ctx.actual) + ' to be within [' + min + ',' + max + ']',
          'Expected ' + __pmStr(ctx.actual) + ' not to be within [' + min + ',' + max + ']');
      },
      closeTo: function(target, delta) {
        var diff = Math.abs(ctx.actual - target);
        return assertCond(diff <= delta,
          'Expected ' + __pmStr(ctx.actual) + ' to be close to ' + target + ' (±' + delta + ')',
          'Expected ' + __pmStr(ctx.actual) + ' not to be close to ' + target + ' (±' + delta + ')');
      },
    };
    chain.be = be;

    // Equality ---------------------------------------------------------------
    chain.equal = function(expected) {
      return assertCond(ctx.actual === expected,
        'Expected ' + __pmStr(expected) + ' but got ' + __pmStr(ctx.actual),
        'Expected value not to equal ' + __pmStr(expected));
    };
    chain.eql = function(expected) {
      return assertCond(__pmDeepEqual(ctx.actual, expected),
        'Expected (deep) ' + __pmStr(expected) + ' but got ' + __pmStr(ctx.actual),
        'Expected value not to deep-equal ' + __pmStr(expected));
    };
    chain.deep = { equal: chain.eql };

    // Inclusion --------------------------------------------------------------
    chain.include = function(needle) {
      return assertCond(__pmIncludes(ctx.actual, needle),
        'Expected ' + __pmStr(ctx.actual) + ' to include ' + __pmStr(needle),
        'Expected ' + __pmStr(ctx.actual) + ' not to include ' + __pmStr(needle));
    };
    chain.contain = chain.include;
    chain.match = function(regex) {
      var re = regex instanceof RegExp ? regex : new RegExp(regex);
      return assertCond(typeof ctx.actual === 'string' && re.test(ctx.actual),
        'Expected ' + __pmStr(ctx.actual) + ' to match ' + re,
        'Expected ' + __pmStr(ctx.actual) + ' not to match ' + re);
    };

    // Property / length / keys / members -------------------------------------
    chain.have = {
      property: function(prop, value) {
        var has = ctx.actual !== null && typeof ctx.actual === 'object' &&
          Object.prototype.hasOwnProperty.call(ctx.actual, prop);
        if (!flip(has)) {
          __pmAssert(false, ctx.negated
            ? 'Expected object not to have property "' + prop + '"'
            : 'Expected object to have property "' + prop + '"');
        }
        if (has && value !== undefined) {
          var v = ctx.actual[prop];
          __pmAssert(flip(__pmDeepEqual(v, value)),
            ctx.negated
              ? 'Expected property "' + prop + '" not to equal ' + __pmStr(value)
              : 'Expected property "' + prop + '" to equal ' + __pmStr(value) + ' but got ' + __pmStr(v));
        }
        return chain;
      },
      length: function(len) {
        var l = (ctx.actual && typeof ctx.actual.length === 'number') ? ctx.actual.length : undefined;
        return assertCond(l === len,
          'Expected length ' + len + ' but got ' + l,
          'Expected length not to be ' + len);
      },
      lengthOf: function(len) { return chain.have.length(len); },
      keys: function() {
        var expected = Array.isArray(arguments[0]) ? arguments[0] : Array.prototype.slice.call(arguments);
        if (ctx.actual === null || typeof ctx.actual !== 'object') {
          __pmAssert(false, 'Expected object but got ' + __pmTypeOf(ctx.actual));
        }
        var actualKeys = Object.keys(ctx.actual);
        var missing = [];
        for (var i = 0; i < expected.length; i++) {
          if (actualKeys.indexOf(expected[i]) === -1) missing.push(expected[i]);
        }
        return assertCond(missing.length === 0,
          'Expected object to have keys ' + __pmStr(expected) + ', missing ' + __pmStr(missing),
          'Expected object not to have keys ' + __pmStr(expected));
      },
      members: function(expected) {
        if (!Array.isArray(ctx.actual)) {
          __pmAssert(false, 'Expected array but got ' + __pmTypeOf(ctx.actual));
        }
        var missing = [];
        for (var i = 0; i < expected.length; i++) {
          var found = false;
          for (var j = 0; j < ctx.actual.length; j++) {
            if (__pmDeepEqual(expected[i], ctx.actual[j])) { found = true; break; }
          }
          if (!found) missing.push(expected[i]);
        }
        return assertCond(missing.length === 0,
          'Expected array to include members ' + __pmStr(expected) + ', missing ' + __pmStr(missing),
          'Expected array not to include members ' + __pmStr(expected));
      },
    };

    // Linking words ----------------------------------------------------------
    // These are no-ops that just return the chain — they're for readability,
    // mirroring chai's English-sentence style: expect(x).to.have.property('y').and.equal(5)
    chain.to = chain;
    chain.and = chain;
    chain.that = chain;
    chain.which = chain;

    // Negation ---------------------------------------------------------------
    Object.defineProperty(chain, 'not', {
      get: function() { return __pmChain(ctx.actual, !ctx.negated); }
    });

    return chain;
  }

  pm.expect = function(actual) { return __pmChain(actual, false); };

  // ---------------------------------------------------------------------------
  // pm.response — convenience assertions against the response global
  // ---------------------------------------------------------------------------
  pm.response = {
    to: {
      have: {
        status: function(code) {
          __pmAssert(typeof response !== 'undefined' && response.status === code,
            'Expected status ' + code + ' but got ' + (typeof response !== 'undefined' ? response.status : 'undefined'));
        },
        header: function(key, value) {
          if (typeof response === 'undefined') __pmAssert(false, 'No response available');
          var headers = response.headers || {};
          var got = headers[key] || headers[String(key).toLowerCase()];
          __pmAssert(!!got, 'Expected header "' + key + '" to exist');
          if (value !== undefined) {
            __pmAssert(got === value,
              'Expected header "' + key + '" to be "' + value + '" but got "' + got + '"');
          }
        },
        body: function(value) {
          if (typeof response === 'undefined' || response.body === undefined) {
            __pmAssert(false, 'Expected response to have body');
          }
          if (value !== undefined) {
            __pmAssert(__pmDeepEqual(response.body, value),
              'Expected body to be ' + __pmStr(value) + ' but got ' + __pmStr(response.body));
          }
        },
        jsonBody: function(path, value) {
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
        ok: function() {
          __pmAssert(typeof response !== 'undefined' && response.status >= 200 && response.status < 300,
            'Expected successful status but got ' + (typeof response !== 'undefined' ? response.status : 'undefined'));
        },
        json: function() {
          __pmAssert(typeof response !== 'undefined' && typeof response.body === 'object',
            'Expected response to be JSON');
        },
        html: function() {
          if (typeof response === 'undefined') __pmAssert(false, 'No response available');
          var ct = (response.headers && (response.headers['content-type'] || response.headers['Content-Type'])) || '';
          __pmAssert(String(ct).indexOf('text/html') !== -1, 'Expected response to be HTML');
        },
      }
    },
    time: {
      below: function(ms) {
        __pmAssert(typeof response !== 'undefined' && response.time < ms,
          'Expected response time below ' + ms + 'ms but got ' + (typeof response !== 'undefined' ? response.time : 'undefined') + 'ms');
      }
    },
    /**
     * Top-level pm.response.json() — Postman convenience that returns the parsed
     * JSON body. The renderer already JSON-parses the response body before
     * binding, so this is effectively an identity read with a fallback parse.
     */
    json: function() {
      if (typeof response === 'undefined') {
        __pmAssert(false, 'No response available');
      }
      if (typeof response.body === 'object' && response.body !== null) return response.body;
      if (typeof response.body === 'string') {
        try { return JSON.parse(response.body); }
        catch (_e) { __pmAssert(false, 'Response body is not valid JSON'); }
      }
      return response.body;
    },
    text: function() {
      if (typeof response === 'undefined') __pmAssert(false, 'No response available');
      if (typeof response.body === 'string') return response.body;
      try { return JSON.stringify(response.body); }
      catch (_e) { return String(response.body); }
    },
    /**
     * Postman shortcut for status code as a property.
     */
    get code() { return typeof response !== 'undefined' ? response.status : undefined; },
    get status() { return typeof response !== 'undefined' ? response.statusText : undefined; },
    get responseTime() { return typeof response !== 'undefined' ? response.time : undefined; },
  };
`;
