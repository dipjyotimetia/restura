# Desktop deep links

The Electron app registers the `restura://` scheme. A deep link only opens an
existing, reviewed UI action; it never sends a request or imports data without
confirmation.

Supported routes:

- `restura://import?url=https%3A%2F%2Fexample.com%2Fcollection.json&format=postman`
- `restura://environment?id=<environment-id>`
- `restura://collection?id=<collection-id>`
- `restura://request?id=<saved-request-id>`
- `restura://settings?section=security`

`format` is optional and may be `postman`, `insomnia`, `openapi`,
`opencollection`, `hoppscotch`, `bruno`, or `http`. Import sources must be
public HTTP(S) URLs without embedded credentials. The user must choose
**Download and import** in Restura before any source is fetched; redirects and
every target pass Restura's normal URL, DNS, and response-size policy.
