// Sandboxed-preview document for untrusted HTML response bodies (moved verbatim
// from ResponseViewer.tsx; see the sandbox/CSP notes in the iframe usage there).
const RESPONSE_PREVIEW_CSP =
  "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src data:; manifest-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; worker-src 'none'";
const RESPONSE_PREVIEW_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${RESPONSE_PREVIEW_CSP}">`;

export function buildResponsePreviewDocument(body: string): string {
  const template = document.createElement('template');
  template.innerHTML = body;

  // Chromium does not currently enforce CSP's navigate-to directive. Remove
  // the small set of navigation-capable attributes while the response is in
  // an inert template so links/forms cannot turn a preview interaction into an
  // outbound request. Subresource URLs remain present and are denied by CSP.
  for (const meta of template.content.querySelectorAll('meta[http-equiv]')) {
    if (meta.getAttribute('http-equiv')?.toLowerCase() === 'refresh') meta.remove();
  }
  for (const link of template.content.querySelectorAll('a, area')) {
    link.removeAttribute('href');
    link.removeAttribute('xlink:href');
    link.removeAttribute('ping');
    link.removeAttribute('target');
  }
  for (const base of template.content.querySelectorAll('base')) {
    base.removeAttribute('href');
    base.removeAttribute('target');
  }
  for (const form of template.content.querySelectorAll('form[action]')) {
    form.removeAttribute('action');
  }
  for (const submitter of template.content.querySelectorAll('[formaction]')) {
    submitter.removeAttribute('formaction');
  }

  // Own the outer document so the browser always parses the policy in <head>.
  // Upstream document tags inside <body> are harmlessly ignored/reparented by
  // the HTML parser while their visible content and inline presentation remain.
  return `<!doctype html><html><head>${RESPONSE_PREVIEW_CSP_META}</head><body>${template.innerHTML}</body></html>`;
}
