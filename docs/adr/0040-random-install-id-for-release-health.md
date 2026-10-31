# ADR 0040: Random install ID for Release Health

**Status:** Accepted, 2026-10-31. Amends the "no identifier" part of [ADR 0027](./0027-telemetry-and-privacy-preserving-usage-analytics.md); the rest of ADR 0027 stands.

## Context

ADR 0027 chose sessions with no identifier and accepted that "unique users" could only ever be an estimate. In practice that signal can't answer how many people use Restura: a session measures launches, so one person opening the app ten times looks the same as ten people opening it once. Sessions were also only sent when the app quit, so an app left open or force-killed was reported late or not until its next launch.

Separately, the release smoke test (`scripts/sentry-smoke.mjs`) reported as `production`, adding its events to production numbers once per desktop build target on every stable release.

## Decision

- **Sessions carry a random per-install ID.** `electron/main/lifecycle/telemetry-install-id.ts` generates a UUID on first use and saves it in `userData`. It is set through `initialScope`, because the session integration reads the user from scope while `Sentry.init` runs.
- **The ID is not derived from anything.** No hardware ID, OS machine ID, hostname, username or account goes into it, so it can't be linked to data outside Sentry's sessions.
- **Sessions only.** `scrubEvent` removes `user` from every error and crash event, so an error can't be tied to an install. This gives up "users affected" on issues.
- **No IP.** `dataCollection.userInfo: false` stays, so the SDK doesn't ask Sentry to infer an IP for sessions.
- **Same opt-out as errors.** Opting out drops the live session (`beforeSend` does not gate sessions), clears the user from scope, and deletes the ID file and the SDK's `sentry/` cache, which holds copies of the ID and queued envelopes. Opting back in creates a new ID, so the two periods can't be linked.
- **An ID that can't be saved isn't sent.** A new ID each launch would count one install as many users.
- **No ID or session until a choice is recorded.** The renderer saves consent only after loading settings, so a first launch, or an install that only ever runs as a headless MCP server, has neither. Errors still report as before. Holding the session until quit doesn't work, because the SDK also sends it on the first error. A consent file that is missing or corrupt counts as no choice.
- **Later launches send their session at launch** (`sendOnCreate`), so they count on the day they run.
- **The renderer waits for settings before sending consent.** It used to send the default (`true`) before Dexie rehydrated, which started Sentry for opted-out users; with sessions at launch and an ID, that gap had to close. Opt-outs still go through if hydration fails.
- **The app ends the session itself at quit.** `main.ts` prevents `will-quit` to await its async cleanup, and the SDK's exit handler skips prevented events, so sessions never ended and every clean quit reported as `abnormal` on the next launch. `endSentrySessionForQuit` now does that work just before `app.exit(0)`. Calling `app.quit()` again instead hangs the app, so don't use it here. Clearing the SDK's `sentry/session.json` marker relies on an SDK internal; `e2e-electron/specs/sentry-sessions.spec.ts` fails if that changes.
- **The smoke test reports as `ci-smoke`.** It keeps its `ci_smoke_test:true` tag.

Web and self-hosted deployments are unchanged: no ID and no sessions.

## Consequences

- Sentry's user counts and crash-free user rate now reflect installs for releases that ship this change. Earlier sessions have no ID, and earlier smoke events stay in `production`; exclude those with `!ci_smoke_test:true`.
- Crash-free rates rise from this release on. That reflects the quit fix, not a stability change: earlier releases counted clean quits as abnormal.
- An install is first counted on its second launch, so someone who runs the app once and never returns isn't counted.
- The ID sits on the SDK scope, and Sentry's logs and metrics copy `user.id` from scope without passing through `scrubEvent`. Neither is enabled today; enabling either must keep the ID off them.
- The count is of installs, not people. A person with two machines counts twice, a reinstall that clears `userData` counts as new, and anyone who opts out isn't counted.
- **This ID is pseudonymous, not anonymous.** It is a stable identifier for one install, so disclosures must say "random install ID" and not call the data anonymous or free of identifiers. It may count as personal data under GDPR, and storing it on the device may fall under ePrivacy rules. It ships under the existing default-on opt-out, which is a product decision that has not had legal review.
- Any richer signal still has to clear ADR 0027's bar or move behind an explicit opt-in. This ID must not be attached to events, added to other telemetry, or derived from anything else.

## References

- Code: `electron/main/main.ts`, `electron/main/lifecycle/sentry.ts`, `electron/main/lifecycle/telemetry-install-id.ts`, `src/lib/electron-sentry.ts`, `scripts/sentry-smoke.mjs`
- Disclosure: `public/privacy.html`, `SECURITY.md`, `README.md`, `docs/DISTRIBUTION.md`, `docs-site/src/content/docs/overview/what-is-restura.mdx`, `docs-site/src/content/docs/architecture/security.mdx`, and the privacy step in `src/components/shared/WelcomeOnboarding.tsx`
