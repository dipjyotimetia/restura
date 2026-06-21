function inherits(ctor, superCtor) {
  if (!superCtor || !superCtor.prototype) return;
  ctor.super_ = superCtor;
  ctor.prototype = Object.create(superCtor.prototype, {
    constructor: { value: ctor, enumerable: false, writable: true, configurable: true },
  });
}
function format(fmt) {
  var args = Array.prototype.slice.call(arguments, 1);
  if (typeof fmt !== 'string') {
    return [fmt]
      .concat(args)
      .map(function (a) {
        return inspect(a);
      })
      .join(' ');
  }
  var i = 0;
  return fmt.replace(/%[sdjifoO%]/g, function (m) {
    if (m === '%%') return '%';
    var v = args[i++];
    switch (m) {
      case '%s':
        return String(v);
      case '%d':
      case '%i':
      case '%f':
        return Number(v);
      case '%j':
        try {
          return JSON.stringify(v);
        } catch (e) {
          return '[circular]';
        }
      default:
        return inspect(v);
    }
  });
}
function inspect(v) {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}
function isArray(v) {
  return Array.isArray(v);
}
function isBuffer() {
  return false;
}
function isObject(v) {
  return v !== null && typeof v === 'object';
}
function isString(v) {
  return typeof v === 'string';
}
function isNumber(v) {
  return typeof v === 'number';
}
function isBoolean(v) {
  return typeof v === 'boolean';
}
function isFunction(v) {
  return typeof v === 'function';
}
function isNull(v) {
  return v === null;
}
function isUndefined(v) {
  return v === undefined;
}
function isDate(v) {
  return v instanceof Date;
}
function isRegExp(v) {
  return v instanceof RegExp;
}
function deprecate(fn) {
  return fn;
}
module.exports = {
  inherits: inherits,
  format: format,
  inspect: inspect,
  isArray: isArray,
  isBuffer: isBuffer,
  isObject: isObject,
  isString: isString,
  isNumber: isNumber,
  isBoolean: isBoolean,
  isFunction: isFunction,
  isNull: isNull,
  isUndefined: isUndefined,
  isDate: isDate,
  isRegExp: isRegExp,
  deprecate: deprecate,
  promisify: function (fn) {
    return function () {
      var self = this,
        args = Array.prototype.slice.call(arguments);
      return new Promise(function (resolve, reject) {
        args.push(function (err, res) {
          err ? reject(err) : resolve(res);
        });
        fn.apply(self, args);
      });
    };
  },
};
