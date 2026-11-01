// restura.dev landing — send people who came for the app straight to it.
// Loaded synchronously from <head> (the CSP forbids inline scripts) so the
// redirect happens before the landing page paints.
//
//  - `?home` always shows the landing page (escape hatch from the app).
//  - Old app URLs (`restura.dev/#/…`, e.g. `#/ai-lab`) keep working.
//  - Returning users (finished first-run onboarding, a localStorage flag the
//    app writes) and the installed PWA (manifest start_url is `/`) skip it.
(() => {
  try {
    const APP = '/app/';
    if (new URLSearchParams(window.location.search).has('home')) return;
    if (window.location.hash.length > 1) {
      window.location.replace(APP + window.location.hash);
      return;
    }
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true;
    const returning = window.localStorage.getItem('restura-onboarding-completed') !== null;
    if (standalone || returning) window.location.replace(APP);
  } catch {
    // Storage blocked (private mode) — just show the landing page.
  }
})();
