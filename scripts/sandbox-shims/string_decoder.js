function StringDecoder(encoding) { this.encoding = (encoding || 'utf-8').toLowerCase(); }
StringDecoder.prototype.write = function (buf) {
  if (typeof TextDecoder !== 'undefined') {
    try { return new TextDecoder(this.encoding).decode(buf); } catch (e) {}
  }
  // Final fallback: byte-by-byte string.
  var out = '';
  for (var i = 0; i < (buf && buf.length || 0); i++) out += String.fromCharCode(buf[i]);
  return out;
};
StringDecoder.prototype.end = function () { return ''; };
module.exports = { StringDecoder: StringDecoder };
