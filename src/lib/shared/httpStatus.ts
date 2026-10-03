/**
 * Plain-language meaning of an HTTP status code, for the response status
 * tooltip. Common codes get a specific line; anything else falls back to its
 * class (2xx/3xx/4xx/5xx). Returns null for 0 (no response — transport errors
 * have their own explanation) and for out-of-range values.
 */
const SPECIFIC: Record<number, string> = {
  100: 'Continue: the server got the headers; send the body.',
  101: 'Switching protocols, e.g. upgrading to WebSocket.',
  200: 'OK: the request succeeded.',
  201: 'Created: a new resource was created.',
  202: 'Accepted: queued for processing, not finished yet.',
  204: 'No content: succeeded, with nothing to return.',
  206: 'Partial content: a byte range of the resource.',
  301: 'Moved permanently: use the URL in the Location header from now on.',
  302: 'Found: temporarily at the URL in the Location header.',
  303: 'See other: fetch the result from the Location header with GET.',
  304: 'Not modified: your cached copy is still current.',
  307: 'Temporary redirect: retry at Location with the same method and body.',
  308: 'Permanent redirect: use Location from now on, same method and body.',
  400: 'Bad request: the server couldn’t parse or validate it.',
  401: 'Unauthorized: missing or invalid credentials.',
  403: 'Forbidden: authenticated, but not allowed to do this.',
  404: 'Not found: nothing at this URL.',
  405: 'Method not allowed for this URL. Check the Allow header.',
  406: 'Not acceptable: no representation matches your Accept header.',
  408: 'Request timeout: the server gave up waiting for the request.',
  409: 'Conflict with the resource’s current state.',
  410: 'Gone: removed permanently.',
  411: 'Length required: send a Content-Length header.',
  412: 'Precondition failed: an If-* header didn’t match.',
  413: 'Payload too large.',
  414: 'URI too long.',
  415: 'Unsupported media type: check the Content-Type header.',
  418: 'I’m a teapot.',
  422: 'Unprocessable content: well-formed, but failed validation.',
  425: 'Too early: the server won’t risk processing a replayable request.',
  428: 'Precondition required: send a conditional header such as If-Match.',
  429: 'Too many requests: rate limited. Check Retry-After.',
  431: 'Request header fields too large.',
  451: 'Unavailable for legal reasons.',
  500: 'Internal server error.',
  501: 'Not implemented: the server doesn’t support this.',
  502: 'Bad gateway: an upstream server sent an invalid response.',
  503: 'Service unavailable: overloaded or down for maintenance. Check Retry-After.',
  504: 'Gateway timeout: an upstream server didn’t answer in time.',
};

const CLASS: Record<number, string> = {
  1: 'Informational response.',
  2: 'Success.',
  3: 'Redirection: the resource is elsewhere.',
  4: 'Client error: something about the request.',
  5: 'Server error: the server failed to handle a valid request.',
};

export function describeHttpStatus(status: number): string | null {
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;
  return SPECIFIC[status] ?? CLASS[Math.floor(status / 100)] ?? null;
}
