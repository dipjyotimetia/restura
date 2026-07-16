# Worker and self-hosted Node layers

Compose HTTP routes through `createApp(deps)` in `worker/app.ts`; Cloudflare and
Node entries provide platform adapters. Every outbound URL uses the shared SSRF
guard and redirect follower. Strip hop-by-hop/sensitive headers, cap bodies and
responses, map errors consistently, and keep local-development bypasses out of
production configuration. When using sockets or native Node APIs, trace both
the Cloudflare handler and the adapter supplied by `worker/node-entry.ts`.
