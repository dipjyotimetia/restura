// Minimal crypto shim — uuid only needs randomFillSync / randomBytes
// (randomUUID is supplied as a global by the prelude). QuickJS has
// Math.random() (not cryptographically secure but acceptable inside a
// sandbox where the host already prevents network egress).
function randomFillSync(buf) {
  for (var i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}
function randomBytes(n) {
  var arr = new Uint8Array(n);
  return randomFillSync(arr);
}
module.exports = { randomFillSync: randomFillSync, randomBytes: randomBytes };
