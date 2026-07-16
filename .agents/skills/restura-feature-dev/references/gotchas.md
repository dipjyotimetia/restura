# Feature-development gotchas

- `npm run type-check` excludes Electron, Worker, CLI, echo, and HTTP subproject
  configs. Use `npm run type-check:all` or `npm run validate`.
- A renderer executor can compile while its preload method or IPC channel is
  missing. Trace the call end to end.
- The Node server reuses `worker/app.ts`, but native WebSocket/TCP adapters may
  differ from Cloudflare.
- Never duplicate SSRF allow/deny logic outside `shared/protocol/url-validation.ts`.
- Raw TCP, PAC, SOCKS, client certificates, Kafka, and MQTT are not browser
  capabilities. Represent the difference in `capabilities.ts`.
- Files computing `__dirname`-relative Electron paths stay at
  `electron/main/` root.
- OpenCollection types and capability markdown are generated artifacts.
