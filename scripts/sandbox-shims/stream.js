function noop() {}
function Stream() {}
Stream.prototype.pipe = noop;
Stream.prototype.on = noop;
Stream.prototype.write = noop;
Stream.prototype.end = noop;
Stream.prototype.emit = noop;
function Readable() { Stream.call(this); }
Readable.prototype = Object.create(Stream.prototype);
function Writable() { Stream.call(this); }
Writable.prototype = Object.create(Stream.prototype);
function Transform() { Stream.call(this); }
Transform.prototype = Object.create(Stream.prototype);
function PassThrough() { Stream.call(this); }
PassThrough.prototype = Object.create(Stream.prototype);
module.exports = {
  Stream: Stream, Readable: Readable, Writable: Writable,
  Transform: Transform, PassThrough: PassThrough
};
module.exports.default = Stream;
