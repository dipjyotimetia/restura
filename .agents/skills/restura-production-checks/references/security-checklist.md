# Security test routing

- URL, redirects, proxy, or new outbound transport: run the SSRF, redirect,
  header-policy, and protocol routing tests under `tests/security/`.
- Electron IPC: test invalid/oversized input, rate limiting, trusted sender, and
  preload/type parity.
- Secrets/auth: test handle isolation, export redaction, and wire-level signing.
- Scripts/viewers/visualizers: run QuickJS and sandbox escape/CSP tests.
- Kafka/MQTT/DNS: verify bootstrap broker guards and document the residual DNS
  rebind or discovered-broker risk from the relevant ADR.

Any change to these boundaries requires `restura-security-auditor` review.
