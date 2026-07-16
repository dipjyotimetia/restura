# Security checklist — change-type → tests

The `tests/security/*` suite runs under coverage-aware `test:ci`, but knowing _which_ test guards _your_ change tells you whether you've broken (or need to extend) a boundary.

For the **Restura security invariants** (single-source SSRF guard, the ADR-0006 DNS-rebind residual window, broker-discovery bypass, the IPC validate + rate-limit + trusted-sender triad, SecretRef isolation, wire-level signing, the QuickJS sandbox boundary), the authoritative list lives in the `restura-security-auditor` agent (`.claude/agents/restura-security-auditor.md`) — it stays self-contained so it can review in isolated context. Dispatch that agent for any diff touching the security surface; don't keep a second copy of the invariants here.

## Change-type → security test mapping

| If you touch…                                                   | Run / extend                                       | Guards                                                                                                              |
| --------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `shared/protocol/url-validation.ts`, any new outbound transport | `tests/security/ssrf.test.ts`                      | Private IPs (RFC1918/6598), link-local 169.254, loopback, cloud metadata, IPv6 ULA/mapped, NAT64                    |
| HTTP executor / web fetch path                                  | `tests/security/http-executor-no-fallback.test.ts` | Regresses the old axios fallback that bypassed the Worker proxy — axios must never see the upstream URL in web mode |
| File access, `file://`, import paths                            | `tests/security/path-traversal.test.ts`            | `file://` rejection, path traversal                                                                                 |
| Response viewer / iframe rendering                              | `tests/security/response-viewer-sandbox.test.ts`   | CSP, no script access to host                                                                                       |
| Script visualizer                                               | `tests/security/visualizer-sandbox.test.tsx`       | jsdom isolation of user scripts                                                                                     |
| AI chat prompt/context                                          | `tests/security/ai-redaction.test.ts`              | Secrets/URLs scrubbed from prompts & logs                                                                           |
| AI Lab provider config                                          | `tests/security/ai-lab-localhost-policy.test.ts`   | localhost carve-out only for local runtimes (Ollama / OpenAI-compatible), never cloud                               |
| Socket.IO transport                                             | `tests/security/socketio-dns-pinning.test.ts`      | DNS-rebind pinning                                                                                                  |
| SSE transport                                                   | `tests/security/sse-proxy-routing.test.ts`         | URL policy + routing honored                                                                                        |

## Built-in vs. this

`/security-review` (built-in) is a general reviewer. The change-type→test mapping above and the invariants in the `restura-security-auditor` agent are Restura-specific knowledge it doesn't have — feed them in, or dispatch the agent.
