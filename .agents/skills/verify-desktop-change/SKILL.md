---
name: verify-desktop-change
description: Verify Restura Electron main-process, packaging, or startup changes by compiling, checking packaged requires, and launching the unpackaged app with RESTURA_SMOKE=1. Use after editing electron/, electron-builder, or the pack-smoke scripts, and before reporting that work done. A green type-check is not a launch.
---

# Verifying desktop launch changes

Use this when the change is under `electron/` (especially `electron/main/lifecycle/`
and main-process startup), `electron-builder.json`, or the pack-smoke scripts
(`scripts/smoke-packaged-electron.mjs`, `scripts/smoke-unpacked-electron.mjs`,
`scripts/verify-packaged-main-requires.mjs`, `scripts/verify-asar-renderer.mjs`).
Renderer-only UI still goes through `verify-ui-change`. A change that does both
needs both skills.

The failure this skill exists for is #1353: the packaged app died before the
window opened because a main-process `require` targeted a module electron-builder
did not ship. Unit tests that mock `start()` do not catch that.

## Procedure

1. **Compile the main process.** `npm run electron:compile`. This also runs
   `node scripts/verify-packaged-main-requires.mjs --check-dev-dependencies`.
   A hit means main or preload imports a devDependency, which the packaged app
   will not contain.
2. **Build the Electron renderer** if `dist/web/index.html` is missing or this
   change touches the renderer shell the window loads (`index.html`, Vite
   electron build, preload path). `npm run electron:build:web`.
3. **Launch unpackaged with the smoke contract.** `npm run electron:smoke:unpacked`
   (`scripts/smoke-unpacked-electron.mjs`). It sets `RESTURA_SMOKE=1` and
   `NODE_ENV=production`, gives the process its own user-data dir, and waits
   until the main frame prints the smoke-ready line and exits 0. On Linux
   without `DISPLAY` it uses `xvfb-run`. A contained feature failure may log
   and still pass. The smoke-failed line or an uncaught exception is a failure.
   This is the local stand-in for the packaged smoke: it does not run
   electron-builder. Budget a minute, not a full installer build.
4. **When an `app.asar` is already built** (`dist/installers/**/app.asar`), also
   run `node scripts/verify-asar-renderer.mjs <asar>` and
   `node scripts/verify-packaged-main-requires.mjs <asar>`, then
   `node scripts/smoke-packaged-electron.mjs`. CI's `Electron pack smoke` gate
   does this on macOS, Windows and Ubuntu for app-path and packaging PRs. Do
   not skip step 3 just because step 4 will run in CI.

If any step fails, fix it and rerun from step 1. Do not report the desktop
change as verified from type-check or unit tests alone.

## What the launch proved

- The main process reached `did-finish-load` on the real window.
- No uncaught main-process exception fired under `RESTURA_SMOKE=1`
  (`electron/main/lifecycle/process-guard.ts` exits 1 on that path).
- DevDependency requires are not on the packaged graph (step 1).

It does not replace Electron desktop e2e for protocol behaviour. Say which
of the two you ran.
