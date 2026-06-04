# Security checklist — change-type → tests + invariants

The `tests/security/*` suite runs under `test:run`, but knowing *which* test guards *your* change tells you whether you've broken (or need to extend) a boundary. Pair this with the `restura-security-auditor` agent for diff review.

## Change-type → security test mapping

| If you touch… | Run / extend | Guards |
|---------------|--------------|--------|
| `shared/protocol/url-validation.ts`, any new outbound transport | `tests/security/ssrf.test.ts` | Private IPs (RFC1918/6598), link-local 169.254, loopback, cloud metadata, IPv6 ULA/mapped, NAT64 |
| HTTP executor / web fetch path | `tests/security/http-executor-no-fallback.test.ts` | Regresses the old axios fallback that bypassed the Worker proxy — axios must never see the upstream URL in web mode |
| File access, `file://`, import paths | `tests/security/path-traversal.test.ts` | `file://` rejection, path traversal |
| Response viewer / iframe rendering | `tests/security/response-viewer-sandbox.test.ts` | CSP, no script access to host |
| Script visualizer | `tests/security/visualizer-sandbox.test.tsx` | jsdom isolation of user scripts |
| AI chat prompt/context | `tests/security/ai-redaction.test.ts` | Secrets/URLs scrubbed from prompts & logs |
| AI Lab provider config | `tests/security/ai-lab-localhost-policy.test.ts` | localhost carve-out only for local runtimes (Ollama / OpenAI-compatible), never cloud |
| Socket.IO transport | `tests/security/socketio-dns-pinning.test.ts` | DNS-rebind pinning |
| SSE transport | `tests/security/sse-proxy-routing.test.ts` | URL policy + routing honored |

## Restura security invariants (don't break these)

1. **SSRF guard is single-source-of-truth.** `shared/protocol/url-validation.ts` is the ONLY place that decides if an address is allowed. It previously drifted between backends — never reimplement per-backend. New transports call `assertResolvedAddressAllowed` (Electron pre-flight via `electron/main/dns-guard.ts`).

2. **Pre-flight DNS ≠ rebind-proof (ADR-0006).** `dns-guard.ts` resolves and checks before connect, but does NOT close the TTL=0 swap window for transports that re-resolve at connect time (gRPC C++ bindings, Kafka auto-discovery, Socket.IO, MCP). Connect-time IP pinning exists for WebSocket/SSE/some gRPC. A new transport that only pre-flights inherits the residual risk — call it out.

3. **Broker guards don't cover discovered brokers.** `kafka-broker-guard.ts` / `mqtt-broker-guard.ts` validate the *bootstrap* brokers only. Brokers auto-discovered from cluster metadata after connect bypass the guard. Private IPs are intentionally allowed (real clusters live on RFC1918); metadata endpoints are not.

4. **Every IPC handler pairs validation + rate-limit + trusted sender.** In `electron/main`, an `ipcMain.handle` must: parse args through a Zod schema (`ipc-validators.ts`, via `createValidatedHandler`), be wrapped by the rate-limiter (`ipc-rate-limiter.ts`), and assert the sender (`assertTrustedSender`). A handler missing any of the three is a finding. Size caps: `MAX_HTTP_BODY_BYTES` (50 MB), `MAX_PROTO_CONTENT_BYTES` (1 MB).

5. **Secret handles never cross to the renderer (ADR-0007).** For `SecretRef { kind: 'handle' }`, plaintext stays in `electron/main/secret-handle-store.ts` and is resolved only at wire-signing time in main. No `resolve` IPC is exposed to the renderer. Exported collections go through `collection-export-redactor.ts`.

6. **Auth signs at the wire, not the renderer (ADR-0016).** SigV4/OAuth1/WSSE sign in Worker/Electron after body construction so the signature matches exact upstream bytes.

7. **Scripts run in QuickJS WASM only.** No DOM, no fs, no network escape; memory + time capped. Don't add host bridges into the sandbox.

## Built-in vs. this

`/security-review` (built-in) is a general reviewer. The mapping and invariants above are Restura-specific knowledge it doesn't have — feed them in, or use the `restura-security-auditor` agent which carries them.
