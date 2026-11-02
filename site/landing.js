// restura.dev landing — forward only the visits that were really for the app.
// Loaded synchronously from <head> (the CSP forbids inline scripts) so the
// redirect happens before the landing page paints.
//
//  - `?home` always shows the landing page (escape hatch from the app).
//  - Old app URLs (`restura.dev/#/…`, e.g. `#/ai-lab`) keep working.
//  - The installed PWA (manifest start_url is `/`) opens the app.
//  - Everyone else, returning users included, sees the landing page; it links
//    to the app. (Auto-forwarding returning users hid the landing entirely.)
(() => {
  try {
    const APP = '/app/';
    if (new URLSearchParams(window.location.search).has('home')) return;
    // Only legacy app routes (`#/…`); in-page anchors like `#compare` stay.
    if (window.location.hash.startsWith('#/')) {
      window.location.replace(APP + window.location.hash);
      return;
    }
    // A shared link to a landing section (`/#compare`) means "show me this".
    if (window.location.hash.length > 1) return;
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true;
    if (standalone) window.location.replace(APP);
  } catch {
    // Anything unexpected — just show the landing page.
  }
})();
