---
name: verify-ui-change
description: Verify any Restura renderer/UI change end-to-end in a real browser before declaring it done. Use after editing anything under src/ that has a visible or interactive surface — components, panels, routes, request builders, stores that drive UI state. Trigger on "does it work", "verify the change", or before reporting any UI edit as complete. A successful edit + green type-check is NOT verification; this skill defines what is.
---

# Verifying UI changes

Never report a renderer change as complete based on a successful edit, a green
`type-check`, or passing unit tests alone. The renderer ships to two harnesses
(web and Electron) and most regressions only show up when the page actually
runs. Verify the way a reviewer would:

## Procedure

1. **Start the dev server** — `npm run dev` (port 5173; boots the Worker via
   Miniflare too, so `/api/*` works). Reuse an already-running instance.
2. **Open the affected surface** in a real browser. Preferred: the Playwright
   MCP browser tools (`browser_navigate`, `browser_snapshot`,
   `browser_take_screenshot`). Routing is hash-based — deep links look like
   `http://localhost:5173/#/<route>`. If the MCP browser tools are not
   available in this session, script it: `npx playwright` with the
   pre-installed Chromium (`executablePath: '/opt/pw-browsers/chromium'` in
   remote sessions).
3. **Interact with the change directly.** For a new control (button, input,
   toggle): click/type/toggle it and assert the observable result — not just
   that it renders. For a protocol panel, execute a request against a safe
   upstream (the echo server, or `npm run echo:local` for desktop-only
   protocols) and confirm the response renders.
4. **Check the browser console** (`browser_console_messages`): zero NEW errors
   or warnings versus a pre-change baseline. Pre-existing noise is not yours;
   anything your change introduced is.
5. **Take a screenshot** of the final state and look at it. Layout breakage,
   dark-mode contrast, and truncation don't show up in DOM assertions.

If any step fails, fix the issue and rerun from step 1 — do not hand back
partially verified work or report "done, but…".

## Quantitative bar

The more measurable the check, the more of this you can self-verify:

- Console: **0 new errors, 0 new warnings.**
- The interaction produces the exact expected text/state (assert it, don't
  eyeball it).
- If the change touches request execution: the response status/body from the
  echo upstream matches expectation.

## Scope caveats

- This verifies the **web harness** only. If the change touches an executor,
  IPC surface, or anything platform-branched (`isElectron()`), web verification
  is necessary but not sufficient — dispatch the `restura-parity-checker`
  agent and say explicitly which harness was verified.
- Desktop-only features (Kafka, mTLS, SOCKS/PAC — see
  `src/lib/shared/capabilities.ts`) cannot be verified this way; run the
  Electron e2e path instead and say so.
