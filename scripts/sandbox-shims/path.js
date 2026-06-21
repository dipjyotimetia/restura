// Browser shim — only what cheerio/xml2js/csv-parse exercise.
function join() {
  return Array.prototype.slice.call(arguments).join('/');
}
function resolve() {
  return Array.prototype.slice.call(arguments).join('/');
}
module.exports = {
  join: join,
  resolve: resolve,
  sep: '/',
  basename: function (p) {
    return String(p).split('/').pop();
  },
};
