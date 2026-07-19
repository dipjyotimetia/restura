# Self-hosting Restura

Restura ships as a single Docker container that an enterprise can run behind
its firewall. The container packages the React SPA and the Hono-based API
proxy (`/api/*`) into one Node process — no Cloudflare account, no external
services required.

This guide covers the production-grade setup. For local development without
Docker, see the root `README.md`.

---

## Quickstart

```bash
# 1. Copy and edit the env file
cp .env.example .env
$EDITOR .env   # set WORKER_PROXY_TOKEN and (optionally) ALLOWED_ORIGIN

# 2. Build + run
docker compose up -d --build

# 3. Verify
curl -fs http://localhost:3000/health
# → {"status":"ok","version":"..."}
```

Open `http://localhost:3000` in a browser. In **Settings → Proxy token**,
paste the `WORKER_PROXY_TOKEN` you set in `.env` so the SPA can authenticate
against the proxy.

### Local source smoke test

For a disposable local build that does not require a `.env` file or a published
image, use the development-only Compose file:

```bash
docker compose -f docker-compose.local.yml up --build --wait
curl -fs http://localhost:3000/health
docker compose -f docker-compose.local.yml down
```

It deliberately enables the development auth bypass and must not be used for
production or exposed beyond your local machine.

---

## Architecture

```
                ┌──── browser ────┐
                │                  │
                ▼                  │ wss /api/ws
       ┌──────────────────────────────────────┐
       │  Docker container :3000              │
       │  Node 24 + @hono/node-server         │
       │                                      │
       │  /                  → SPA (static)   │
       │  /api/proxy         → HTTP/REST      │
       │  /api/grpc          → gRPC (unary +  │
       │                       streaming)     │
       │  /api/mcp           → MCP            │
       │  /api/ws            → WebSocket      │
       │  /api/ws-ticket     → WS ticket      │
       │  /api/feature-flags →                │
       │  /api/telemetry/*   → (opt-in)       │
       │  /health, /ready    → probes         │
       └──────────────────────────────────────┘
                              │
                              ▼
                  user-controlled upstreams
```

The container is **stateless**. All user data (collections, environments,
history, settings) lives in IndexedDB in the browser — nothing is persisted
on the server side.

The self-hosted server collects **no usage analytics** — Restura runs no
application-level usage instrumentation anywhere (see
[ADR-0027](adr/0027-telemetry-and-privacy-preserving-usage-analytics.md)). The
only outbound reporting a self-hosted deployment can do is the opt-out renderer
error sink at `/api/telemetry/error`, which logs (never stores) redacted error
reports.

---

## Environment variables

| Var                  | Required        | Default                     | Purpose                                                                                      |
| -------------------- | --------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `WORKER_PROXY_TOKEN` | Yes¹            | _(unset → 503)_             | Shared secret. SPA sends it in `X-Restura-Proxy-Token`.                                      |
| `REQUIRE_CF_ACCESS`  | Yes¹            | `false`                     | Trust a reverse-proxy `Cf-Access-Authenticated-User-Email` header instead of a Bearer token. |
| `ENVIRONMENT`        | No              | `production`                | Anything other than `development` enforces full auth + SSRF.                                 |
| `ALLOWED_ORIGIN`     | No              | _(echo request Origin)_     | Comma-separated CORS allow-list. Supports `*` inside hostnames.                              |
| `ALLOW_PRIVATE_IPS`  | No              | `false`                     | Permit RFC 1918 / link-local / CGNAT upstreams. See _Internal-network access_ below.         |
| `RATE_LIMITER`       | No              | `map`                       | Always `map` in self-hosted (per-process limiter).                                           |
| `PORT` / `HOST`      | No              | `3000` / `0.0.0.0`          | Bind address inside the container.                                                           |
| `VITE_ECHO_*_URL`    | No              | _(public echo.restura.dev)_ | **Build-time.** Replace the SPA's placeholder URLs with internal echo endpoints.             |
| `DEV_BYPASS_AUTH`    | _Never in prod_ | _(unset)_                   | Local dev only. Bypasses auth + allows localhost SSRF.                                       |

¹ At least one of `WORKER_PROXY_TOKEN` or `REQUIRE_CF_ACCESS=true` MUST be
set. The Worker fails-closed with HTTP 503 otherwise.

---

## Auth modes

### Mode A — Bearer token (default)

Set `WORKER_PROXY_TOKEN` to a 32-byte hex string. The SPA sends it in
`X-Restura-Proxy-Token`. The Worker compares with a constant-time check.

```bash
openssl rand -hex 32   # generate a token
```

### Mode B — Reverse-proxy auth header

If you already run an SSO gateway (Cloudflare Access, Pomerium, oauth2-proxy,
Tailscale Funnel, Vouch, etc.), let it terminate auth and inject
`Cf-Access-Authenticated-User-Email`. Set `REQUIRE_CF_ACCESS=true` and leave
`WORKER_PROXY_TOKEN` unset.

The Worker does NOT validate the header's authenticity — your reverse proxy
must be the only ingress, and must strip the header from untrusted callers.

### Mode C — Local development

`ENVIRONMENT=development` + `DEV_BYPASS_AUTH=true`. Auth is skipped, localhost
upstreams are permitted. **Never** set this in a deployed environment.

---

## Recommended: front with a TLS-terminating reverse proxy

The Docker image speaks plain HTTP. For production, put a reverse proxy in
front for TLS, gzip, and access control. Minimal Caddy example:

```caddyfile
restura.corp.example {
    reverse_proxy restura:3000
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        Content-Security-Policy "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:;"
        Referrer-Policy "strict-origin-when-cross-origin"
        X-Frame-Options "DENY"
    }
}
```

With Traefik / nginx / a K8s ingress, the same idea applies — terminate TLS,
forward to `restura:3000`.

---

## Internal-network access (`ALLOW_PRIVATE_IPS`)

Out of the box, the SSRF guard refuses any upstream that resolves to
RFC 1918, RFC 6598 (CGNAT), link-local 169.254/16, IPv6 unique-local, or any
loopback / cloud-metadata endpoint.

To proxy to internal services (Jenkins on `https://jenkins.corp.example`,
internal APIs, etc.), set `ALLOW_PRIVATE_IPS=true`. The guard still blocks
cloud-metadata endpoints (`169.254.169.254`, `metadata.google.internal`,
etc.) — those remain hard-blocked regardless.

**Caveat — DNS rebind.** `ALLOW_PRIVATE_IPS=true` relaxes the pre-flight
guard but does NOT mitigate a true DNS-rebind attack (TTL=0, address swapped
between guard check and the actual TCP connect). If your environment includes
endpoints that authenticate solely on private-IP source addresses, run
Restura on a network segment where it can only reach explicitly intended
upstreams. See `docs/adr/0006-electron-connection-and-dns-hardening.md` for
the full threat model.

---

## Rate limiting

The self-hosted build uses a per-process in-memory limiter (default
100 req / 60s per client). The bucket key falls through this chain:

1. `True-Client-IP` — set by Cloudflare-style upstreams.
2. `CF-Connecting-IP` — never set on self-hosted; included for parity.
3. Identity-aware tokens (`X-Restura-Proxy-Token` / `Authorization`).
4. `User-Agent` hash — last-ditch so a missing IP header doesn't collapse
   every client into one shared bucket.

**Important:** if you're not behind a reverse proxy that sets a trusted
client-IP header, every browser-direct request shares the UA-hash bucket
(small cardinality). Run Caddy / nginx / Traefik / a K8s ingress in front
and have it set `True-Client-IP` from the real client address.

For a multi-replica deployment, each replica enforces independently — a
6-replica deployment effectively grants 600 req / 60s. Two options:

1. **Front with a load-balancer rate-limiter** (Caddy, nginx, ingress) — the
   single source of truth, doesn't depend on the app.
2. **Single replica** + horizontal scale only after you've measured demand.
   Most enterprise teams (≤ 200 engineers) sustain on one replica.

Setting `RATE_LIMITER=binding` or `binding-shadow` is rejected at startup
in self-hosted builds — those modes require the Cloudflare Rate-Limiting
binding object, which has no Node equivalent. Use `map` (the default).

A Redis-backed limiter is on the roadmap but not v1.

---

## WebSocket tickets — single-replica only

WebSocket proxying uses a one-shot ticket: the SPA POSTs `/api/ws-ticket`,
the server stashes the target URL in an in-process map keyed by a random
UUID, the SPA then opens `wss://.../api/ws?ticket=<id>` (browsers can't set
headers on the upgrade, so the ticket is how custom headers / protocols
flow through).

The ticket map is process-local and tickets expire in 30 seconds. This
means:

- **Multiple replicas behind a load balancer don't work** — if `/api/ws-
ticket` lands on replica A and `/api/ws` lands on replica B, the ticket
  is unknown to B and the upgrade closes with code 1008.
- **Container restarts invalidate in-flight tickets** — affects only the
  ~30-second window after each restart; usually harmless.

For the v1 release, run Restura as a single replica (the default
docker-compose.yml does this). Sticky-session routing on the LB would also
work but adds complexity. A shared-store (Redis / KV / DO) ticket map is
roadmap.

---

## Updating

```bash
docker compose pull
docker compose up -d
```

The container has no auto-update; you control the release cadence. There is
NO outbound call to GitHub or any update endpoint from the web container.

The Electron desktop app does check GitHub releases by default. Enterprises
building their own Electron image can disable this by setting
`RESTURA_DISABLE_AUTO_UPDATE=true` in the launching environment.

---

## Healthchecks

| Path      | Purpose                                                                                          | Auth |
| --------- | ------------------------------------------------------------------------------------------------ | ---- |
| `/health` | Liveness — confirms the process is responsive. Returns 200 + JSON.                               | None |
| `/ready`  | Readiness — currently identical to `/health`; reserved for future per-replica readiness signals. | None |

For Kubernetes:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
readinessProbe:
  httpGet:
    path: /ready
    port: 3000
```

---

## Verifying the build

After `docker compose up`, sanity-check the major code paths:

```bash
# Health
curl -fs http://localhost:3000/health

# SPA delivery
curl -fsI http://localhost:3000/ | head -1

# HTTP proxy (needs WORKER_PROXY_TOKEN)
curl -fs -X POST http://localhost:3000/api/proxy \
  -H "X-Restura-Proxy-Token: $WORKER_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"method":"GET","url":"https://httpbin.org/get"}'

# SSRF guard still in force (should return 400, not connect)
curl -fs -X POST http://localhost:3000/api/proxy \
  -H "X-Restura-Proxy-Token: $WORKER_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"method":"GET","url":"http://169.254.169.254/"}'
```

---

## Building a custom image

If you want to bake internal-only echo URLs (or any other build-time config)
into your image:

```bash
docker build \
  --build-arg VITE_ECHO_HTTP_URL=https://echo.corp.example/anything \
  --build-arg VITE_ECHO_WS_URL=wss://echo.corp.example/ws \
  -t registry.corp.example/restura/web:v0.1.0 .
docker push registry.corp.example/restura/web:v0.1.0
```

Note: `VITE_*` vars are read at SPA build time, not at runtime — they're
inlined into the JS bundle. Changing them after the image is built has no
effect.

---

## Troubleshooting

| Symptom                                                                              | Likely cause                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 503 on every `/api/*` request                                                        | Neither `WORKER_PROXY_TOKEN` nor `REQUIRE_CF_ACCESS=true` is set.                                      |
| CORS errors in the browser console                                                   | `ALLOWED_ORIGIN` doesn't include the SPA hostname. Use a comma-separated list or `*` wildcards.        |
| Upstreams to internal IPs return 400 "Private/internal IP addresses are not allowed" | Set `ALLOW_PRIVATE_IPS=true` (and read the DNS-rebind caveat above).                                   |
| WebSocket connects but no frames flow                                                | Reverse proxy isn't forwarding the `Upgrade: websocket` header. Caddy / nginx need explicit WS config. |
| `/health` returns 200 but the SPA shows "SPA bundle not found"                       | The build stage didn't run, or `RESTURA_STATIC_ROOT` is misconfigured.                                 |

---

## Out of scope (for v1)

- **Distributed rate limiting** — single-replica or load-balancer rate-limit only.
- **Server-side persistence** — no shared collections / shared workspaces; storage is browser-local.
- **Helm chart** — drop the Dockerfile into your existing Helm/K8s tooling.
- **mTLS for upstreams** — Electron-only; not exposed in the web build.

These are tracked on the roadmap and welcome as PRs.
