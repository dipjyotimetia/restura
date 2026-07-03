# ADR 0027: Telemetry and Privacy-Preserving Usage Signal

**Status:** Accepted, 2026-07-03

## Context

Restura ships a crash/error-reporting subsystem but, until now, had **no
architectural decision record** for it and captured **no usage signal at all** —
so we had no privacy-respecting way to answer even the most basic question, "how
many people actually use Restura?"

The existing telemetry surface (unchanged in intent by this ADR):

- **Desktop (Electron)** — `electron/main/lifecycle/sentry.ts`. Errors + native
  crashes via `@sentry/electron`. Tracing is deliberately **off**
  (`tracesSampleRate` unset) because a span could carry the user's proxied
  request URL. `sendDefaultPii: false` plus an aggressive `scrubEvent` drops the
  request context, hostname, user, stack-frame locals, and breadcrumb data, and
  redacts secrets/file-paths from all free text. Opt-out, on by default, gated on
  `settings.telemetry.errorsEnabled` (mirrored to the main process via
  `telemetry-consent.ts`).
- **Web / self-host** — `worker/handlers/telemetry.ts`. `/api/telemetry/error`
  is a redacted, rate-limited, allowlist-only **log sink** (`console.log` for
  `wrangler tail`) — never stored, never forwarded to a third party.

The gap: measuring **usage** collides with Restura's public promise of _"no
analytics or behavioural tracking."_ We wanted the smallest possible signal that
answers "how many people use it" **without** adding per-request instrumentation,
a device/user identifier, or a third-party analytics SDK.

## Decision

Take the **bare minimum**: adopt the single lowest-cost usage signal that already
exists, disclose it, and add **no new app-level counting**.

### Adopted — Sentry Release Health (desktop), made explicit

`@sentry/electron` enables main-process session tracking by default (via
`mainProcessSessionIntegration`), so Release Health sessions were **already being
sent** for opted-in desktop users — but this was undocumented. We now list the
integration **explicitly** in `Sentry.init({ integrations: [...] })` so an SDK
default change can't silently flip this signal, and we disclose it.

Release Health emits anonymous session envelopes (session start/end, crash-free
rate, version adoption) — enough to gauge active users **without any device or
user identifier**. Sessions carry no IP (`sendDefaultPii: false`) and no user id,
and are gated by the same opt-out as errors (we only `init()` when opted in).
Like native crash capture, a mid-session opt-out fully stops sessions on the next
launch.

### Web usage — rely on Cloudflare's built-in dashboard, add nothing

The hosted Worker already has `observability.enabled: true` (`wrangler.jsonc`),
so **request volume, status codes, and coarse geography are already visible in
Cloudflare's own dashboard** — infrastructure-level metrics Cloudflare collects
for any Worker, with **no application code and nothing we record ourselves**.
That covers "how many requests / roughly where" for the web app at the bare
minimum, so we write no per-request datapoints of our own.

### Rejected — application-level request counting (Analytics Engine)

An earlier draft added a Workers Analytics Engine middleware writing an anonymous
aggregate datapoint (endpoint category, method, status class, country) per
`/api/*` request. **Rejected as more than the bare minimum**: Cloudflare's
built-in dashboard already answers the volume question, so per-request app
instrumentation was redundant surface area for a privacy-focused app. If a
genuine need for protocol-level product metrics appears later, revisit it behind
the same bar — aggregate, non-identifying, no per-user handle — or an explicit
opt-in.

### Documentation reconciliation

- `public/privacy.html`, `README.md`, `SECURITY.md`, and
  `docs-site/.../what-is-restura.mdx` updated so "no **per-user** tracking or
  behavioural profiling" replaces the previously-absolute "no analytics," and the
  desktop Release Health signal is disclosed.
- `docs/DISTRIBUTION.md`'s stale "Monitoring and Analytics" section (which
  recommended integrating **Countly** and **Matomo**) is corrected — those
  contradict Restura's privacy posture and per-user tracking is out of scope.

## Consequences

**Positive**

- We can answer "how many people use it" at an aggregate level — desktop active
  sessions + crash-free rate + version adoption from Release Health, and web
  request volume from Cloudflare's dashboard — with **zero** new app-level
  collection and no personal data.
- The telemetry subsystem now has an ADR, and the previously-undocumented Sentry
  session behaviour is explicit and disclosed.
- Self-hosters get a clean guarantee: **no** usage collection server-side.

**Negative / limitations**

- **No precise unique-user count.** The signal is aggregate; we deliberately hold
  no identifier, so "unique users" is only ever an estimate (edge sessions /
  crash-free session counts), never a per-device MAU.
- **Web active-user counts are coarser than desktop.** The web app has no
  Release-Health equivalent; we rely on Cloudflare's request-level dashboard,
  which measures traffic, not sessions.
- Any future richer signal must clear the same bar — aggregate, non-identifying —
  or move behind an explicit opt-in.

## References

- Code: `electron/main/lifecycle/sentry.ts` (explicit
  `mainProcessSessionIntegration`), `wrangler.jsonc` (`observability.enabled`)
- Tests: `electron/main/__tests__/sentry.test.ts`
- Disclosure: `public/privacy.html`, `README.md`, `SECURITY.md`,
  `docs/DISTRIBUTION.md`, `docs-site/src/content/docs/overview/what-is-restura.mdx`
- Related: [ADR 0004 (security hardening)](./0004-security-hardening.md),
  [ADR 0007 (secret-ref pattern)](./0007-secret-ref-pattern.md),
  [ADR 0026 (CSP + permission hardening)](./0026-electron-csp-and-permission-hardening.md)
