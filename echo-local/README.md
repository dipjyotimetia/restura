# echo-local — full-protocol local test stack

A developer-facing local upstream that runs **every** Restura protocol on stable,
documented ports so you can drive the **installed/dev desktop client** against it
and exercise real auth, TLS, mTLS, and broker round-trips — the things the
web-only `echo/` Cloudflare Worker can't host.

It reuses the existing `e2e/mocks/*` servers and the native gRPC dev server in
place; the only new pieces are this launcher, a local CA + mTLS listener, and a
generated importable collection. Kafka and MQTT need real brokers (Redpanda +
EMQX), which run via Docker.

## Quick start

```bash
npm run echo:local                 # boot the in-process protocols, print the manifest, stay up
# (for Kafka + MQTT — both run in Docker)
docker compose -f echo-local/docker-compose.yml up -d
```

Then launch the desktop app (`npm run electron:dev`, or your installed build) and
either **import the generated collection** and click Send, or wire requests by
hand from the printed manifest.

Generated on each run (git-ignored): `echo-local/manifest.json`,
`echo-local/restura-echo-local.collection.json`, `echo-local/certs/`.

### Other commands

```bash
npm run echo:local -- --only http,grpc,ws     # subset of in-process services
npm run echo:local -- --no-tls                # skip https/mtls
npm run echo:local -- --domain echo.local     # certs SAN + manifest use a custom host
npm run echo:local:certs                      # (re)generate the CA + leaf certs, exit
npm run echo:local:collection                 # write the importable collection, exit
npm run echo:local -- manifest                # write + print the manifest, exit
```

`--domain echo.local` requires a hosts entry: `127.0.0.1  echo.local` in
`/etc/hosts`. Without it, use `localhost` / `127.0.0.1` (the default).

## Ports

| Service          | URL                                                | Notes                                                                        |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| HTTP             | `http://localhost:8080`                            | echo + all OAuth/JWT/SigV4/Digest/API-key routes                             |
| HTTPS            | `https://localhost:8443`                           | CA-signed server cert                                                        |
| HTTPS mTLS       | `https://localhost:8444`                           | requires a client cert; `GET /mtls/whoami` confirms it                       |
| HTTP proxy       | `http://localhost:8888`                            | forward + CONNECT                                                            |
| gRPC             | `grpc://localhost:50051`                           | `echo.v1.EchoService`, reflection on                                         |
| WebSocket        | `ws://localhost:8085/echo`                         | also `/chat` `/graphql` `/ping` `/close`                                     |
| Secure WebSocket | `wss://localhost:8543/echo`                        | same paths over TLS (CA-signed); the packaged desktop CSP allows `wss:` only |
| Socket.IO        | `http://localhost:8086`                            | namespaces `/` `/chat` `/admin`                                              |
| MCP              | `http://localhost:8087/mcp`                        | streamable-http                                                              |
| MQTT             | `mqtt://localhost:1883` / `mqtts://localhost:8883` | EMQX MQTT 5 (Docker); dashboard `:18083` (admin/public)                      |
| Kafka            | `localhost:9092`                                   | Redpanda (Docker)                                                            |

## Credentials

From `e2e/mocks/authRoutes.ts` (`TEST_AUTH_FIXTURES`) — the exact values the
servers validate:

- OAuth2 client: `restura-client` / `restura-secret`
- User (password/basic/digest): `alice` / `wonderland`
- AWS SigV4: `AKIDEXAMPLE` / `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`, region `us-east-1`, service `execute-api`
- API key sample: header `X-API-Key: secret123` (or query `?api_key=secret123`)

## TLS / mTLS / custom-CA

`echo-local/certs/` holds a local CA and CA-signed server + client leaves:

1. **custom-CA** — import `certs/ca.crt` into Restura's custom-CA setting; then
   `https://localhost:8443` validates without `verifySsl` off.
2. **mTLS** — attach `certs/client.crt` + `certs/client.key` (or `certs/client.p12`,
   passphrase `restura`) and call `https://localhost:8444/mtls/whoami`. It returns
   the accepted client-cert subject — proof the mutual handshake worked. The same
   endpoint on `:8443` returns `mtls:false`.

## The generated collection (import → Send → works)

`restura-echo-local.collection.json` has one runnable request per protocol the
OpenCollection format supports, with auth that round-trips cleanly:

- HTTP: no-auth, **Basic**, **Bearer**, **API key (header + query)**, **AWS SigV4**
- GraphQL, gRPC (UnaryEcho via reflection), SSE, MCP

URLs are literal `localhost` ports, so it works without selecting an environment.

## Driven manually (not in the collection)

These are connection-based or lossy on OpenCollection import — use the manifest:

- **WebSocket / Socket.IO / MQTT / Kafka** — connect interactively (subscribe then
  publish, etc.). WebSocket: `ws://localhost:8085/echo` or, for the packaged build,
  `wss://localhost:8543/echo` (import the CA, or verify-SSL off). MQTT (EMQX, MQTT 5):
  subscribe `test/#`, publish `test/echo`;
  `mqtts://localhost:8883` uses EMQX's self-signed cert (verify-SSL off). Kafka:
  create topic `echo`, produce, consume from earliest.
- **OAuth2** — configure client-credentials manually: token URL
  `http://localhost:8080/oauth/token`, client `restura-client`/`restura-secret`,
  scope `read`; call `GET /oauth/protected`. (OpenCollection import drops the grant
  type, so this one can't be a click-Send collection entry.)
- **WSSE** — OpenCollection import is lossy, so configure manually (UsernameToken /
  PasswordDigest). `GET /wsse/protected` verifies the `X-WSSE` digest end-to-end.
- **OAuth1** — signed at the wire, but import is lossy and there is no verification
  endpoint (the HMAC-SHA1 base string is built inside the `oauth-1.0a` package, so a
  faithful server-side verifier can't reuse the signer's logic); configure manually.
- **Digest / NTLM** — the desktop client transport doesn't apply these yet (the
  server supports Digest for reference).
