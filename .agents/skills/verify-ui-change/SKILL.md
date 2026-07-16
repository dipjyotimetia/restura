---
name: verify-ui-change
description: Use after changing any visible or interactive Restura renderer surface, before reporting the UI behavior complete.
---

# Verify Restura UI changes

1. Start `npm run dev` and open the hash-routed surface in a real browser.
2. Exercise the changed interaction and assert the observable state or safe echo
   response; rendering alone is not verification.
3. Confirm zero new console errors or warnings.
4. Inspect a screenshot for layout, contrast, truncation, and responsive issues.
5. If execution branches on `isElectron()`, also run the applicable Electron
   E2E path and request `restura-parity-checker` review.

Do not claim success from type-checks or unit tests alone. Localhost proxying
requires `ENVIRONMENT=development` in `.dev.vars` so the shared SSRF policy can
allow it intentionally.
