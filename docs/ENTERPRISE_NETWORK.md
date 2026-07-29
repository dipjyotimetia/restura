# Enterprise desktop networking

Restura Desktop can consume a protected machine policy for outbound networking
and application updates. The policy configures the existing Electron network
sessions and `electron-updater`; it does not add an account, policy service, or
separate enterprise control plane.

This feature is desktop-only. Web, self-hosted, CLI, and extension behavior is
unchanged.

## Policy sources and precedence

Restura selects exactly one source at startup:

1. Windows `HKLM\Software\Policies\Restura\EnterprisePolicy` or the macOS
   managed preference
   `com.dipjyotimetia.restura` / `EnterprisePolicy`
2. The file selected by `RESTURA_ENTERPRISE_POLICY_FILE`
3. The default machine file:
   - Windows: `%ProgramData%\Restura\policy.json`
   - macOS: `/Library/Application Support/Restura/policy.json`
   - Linux: `/etc/restura/policy.json`

The first selected source is authoritative. Invalid or unreadable selected
policy never falls back to a lower-precedence source. Unix policy files must be
owned by root and must not be group- or world-writable. Windows policy files
must live under `ProgramData` and be writable only by administrators.

## Example

```json
{
  "version": 1,
  "network": {
    "mode": "pac",
    "requireProxy": true,
    "pacUrl": "https://config.example.com/restura.pac",
    "bypassList": ["localhost", "*.internal.example.com"],
    "proxyAuthentication": {
      "basic": [
        {
          "proxyUrl": "https://proxy.corp.example:8443",
          "usernameEnv": "RESTURA_PROXY_USERNAME",
          "passwordEnv": "RESTURA_PROXY_PASSWORD"
        }
      ],
      "integratedDomains": ["proxy.corp.example", "*.proxy.corp.example"]
    },
    "caCertificatePaths": ["/etc/restura/corporate-ca.pem"],
    "requireCertificateVerification": true,
    "minimumTlsVersion": "TLSv1.2",
    "directProtocols": ["kafka"]
  },
  "updates": {
    "mode": "auto-download",
    "channel": "stable",
    "feedUrl": "https://updates.example.com/restura",
    "requestHeaderEnv": {
      "Authorization": "RESTURA_UPDATE_AUTHORIZATION"
    }
  }
}
```

The schema is strict. Unknown fields invalidate the policy.

## Network behavior

`network.mode` supports:

- `system`: use the operating-system proxy configuration.
- `fixed`: use `proxyUrl`, which must be an HTTP or HTTPS URL without inline
  credentials.
- `pac`: use the HTTPS `pacUrl`.
- `direct`: connect without a proxy.

When `requireProxy` is true, a PAC or system result of `DIRECT` is rejected
unless the destination matches `bypassList`. HTTP, SSE, MCP, WebSocket,
Socket.IO, gRPC, GraphQL, AI provider calls, Git HTTPS, and application updates
use the managed route. Raw Git SSH, Kafka, and MQTT connections require an
explicit `directProtocols` exception because these protocols cannot traverse an
HTTP CONNECT policy generically.

`proxyAuthentication.basic` binds each Basic credential pair to one exact
HTTP(S) proxy origin. Credentials are read from the named environment variables
in the main process; inline credentials and duplicate proxy origins are
rejected. This mapping works for fixed proxies and for matching proxies returned
by PAC or system resolution.

`proxyAuthentication.integratedDomains` is an explicit proxy-host allowlist for
Negotiate authentication. Exact DNS names and leading wildcards such as
`*.proxy.corp.example` are accepted. Electron sessions enable native
NTLM/Negotiate for those domains. Node-based desktop transports use the
operating-system GSSAPI/SSPI credential cache to create a SPNEGO token, so no
domain password is stored in the policy or renderer. Integrated credentials are
never requested for a proxy outside this allowlist.

Managed certificate verification cannot be disabled by renderer settings.
Managed CA bundles are bounded to 2 MiB and the configured minimum TLS version
is enforced for both the destination and an HTTPS proxy while preserving any
stricter per-request value. CA paths must be absolute, regular non-symlink
files under administrator control, and each certificate must be parseable and
currently valid. The bundle is applied to Electron sessions (including updates)
and to Node-based desktop protocol transports.

## Managed update feed

Enabled managed updates require an HTTPS `feedUrl`. Restura configures the
existing generic `electron-updater` provider and applies the same system, fixed,
or PAC proxy policy to the updater's dedicated Electron session before checking
or downloading.

`requestHeaderEnv` maps `Authorization` or `X-*` request headers to environment
variable names. Secrets are resolved only in the main process and are never
returned through the renderer status API.

Update modes are `disabled`, `notify`, `auto-download`, and `install-on-quit`.
Channels are `stable` and `beta`. When managed, local proxy and automatic-update
controls are locked. A manual check uses the managed feed only when updates are
enabled; disabled or invalid managed policy cannot fall back to a public feed.

## Failure behavior

Policy loading and startup application are fail-closed. An invalid policy,
missing referenced update header, unavailable required proxy credential, invalid
CA bundle, or mandatory proxy resolving to `DIRECT` blocks the affected
outbound operation. Renderer diagnostics expose only a redacted status and ask
the user to contact their administrator.
