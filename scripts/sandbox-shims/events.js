function EventEmitter() { this._listeners = {}; }
EventEmitter.prototype.on = function (e, fn) {
  (this._listeners[e] = this._listeners[e] || []).push(fn);
  return this;
};
EventEmitter.prototype.addListener = EventEmitter.prototype.on;
EventEmitter.prototype.once = function (e, fn) {
  var self = this;
  function w() { self.off(e, w); fn.apply(null, arguments); }
  return self.on(e, w);
};
EventEmitter.prototype.off = function (e, fn) {
  var l = this._listeners[e]; if (!l) return this;
  this._listeners[e] = l.filter(function (f) { return f !== fn; });
  return this;
};
EventEmitter.prototype.removeListener = EventEmitter.prototype.off;
EventEmitter.prototype.emit = function (e) {
  var l = (this._listeners[e] || []).slice();
  var args = Array.prototype.slice.call(arguments, 1);
  for (var i = 0; i < l.length; i++) l[i].apply(this, args);
  return l.length > 0;
};
EventEmitter.prototype.removeAllListeners = function (e) {
  if (e) delete this._listeners[e]; else this._listeners = {};
  return this;
};
EventEmitter.prototype.setMaxListeners = function () { return this; };
module.exports = EventEmitter;
module.exports.EventEmitter = EventEmitter;
module.exports.default = EventEmitter;
