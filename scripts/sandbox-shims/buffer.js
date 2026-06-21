var Buffer = {
  isBuffer: function (v) {
    return v && typeof v === 'object' && v.byteLength !== undefined;
  },
  from: function (data, enc) {
    if (typeof data === 'string') {
      var arr = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i) & 0xff;
      return arr;
    }
    return new Uint8Array(data || 0);
  },
  alloc: function (n) {
    return new Uint8Array(n);
  },
  allocUnsafe: function (n) {
    return new Uint8Array(n);
  },
  byteLength: function (s) {
    return typeof s === 'string' ? s.length : (s && s.byteLength) || 0;
  },
  concat: function (arr) {
    var total = 0;
    for (var i = 0; i < arr.length; i++) total += arr[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < arr.length; j++) {
      out.set(arr[j], off);
      off += arr[j].length;
    }
    return out;
  },
};
module.exports = { Buffer: Buffer };
