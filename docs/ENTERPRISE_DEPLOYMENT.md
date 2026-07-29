# Enterprise desktop deployment

Restura's Electron desktop build can be deployed with one machine-managed JSON
policy. The policy controls outbound routing, TLS trust, updates, telemetry, AI
destinations, and selected high-risk features without adding an enterprise
control-plane service.

This support is intentionally narrow: it is for administrators deploying the
desktop application to engineers behind an authenticated HTTP(S) proxy. It does
not add accounts, SSO, RBAC, shared workspaces, or an audit backend.

## Deployment sequence

1. Sign the desktop package with your organization's trusted signing identity.
2. Install any corporate root CA in the operating-system trust store. Add the
   PEM path to the policy when Restura's Node transports must use it as well.
3. Deploy proxy credentials as machine/service environment variables if Basic
   authentication is required.
4. Deploy the policy using the native machine-policy location where possible.
5. Start Restura and verify the **Managed by your organization** status in
   Settings.
6. Test HTTP, WebSocket, SSE, MCP, gRPC, Git HTTPS, and update checks through
   the real enterprise proxy before broad rollout.

## Policy sources and precedence

Restura reads the first selected source below. If that source exists but is
invalid, startup stays in a diagnostics-only, fail-closed state; Restura does
not fall back to a less trusted source.

| Priority | Platform | Source |
| --- | --- | --- |
| 1 | Windows | `HKLM\Software\Policies\Restura`, string value `EnterprisePolicy` |
| 1 | macOS | managed preference `com.dipjyotimetia.restura`, key `EnterprisePolicy` |
| 2 | All | file named by `RESTURA_ENTERPRISE_POLICY_FILE` |
| 3 | Windows | `%ProgramData%\Restura\policy.json` |
| 3 | macOS | `/Library/Application Support/Restura/policy.json` |
| 3 | Linux | `/etc/restura/policy.json` |

The native value contains the complete JSON document. The maximum document size
is 256 KiB. Unknown keys and malformed values are rejected.

On macOS and Linux, policy files must be owned by root and must not be group or
world writable. On Windows, policy files must be below `%ProgramData%`; deploy
the `Restura` directory with an ACL that grants write access only to
Administrators and SYSTEM. The HKLM source is preferred on Windows because its
machine-policy ACL is managed by the operating system.

## Policy example

```json
{
  "version": 1,
  "network": {
    "mode": "fixed",
    "requireProxy": true,
    "proxyUrl": "http://proxy.corp.example:8080",
    "bypassList": ["localhost", "*.corp.example"],
    "usernameEnv": "RESTURA_PROXY_USERNAME",
    "passwordEnv": "RESTURA_PROXY_PASSWORD",
    "caCertificatePaths": ["/etc/restura/corporate-ca.pem"],
    "requireCertificateVerification": true,
    "minimumTlsVersion": "TLSv1.2",
    "directProtocols": []
  },
  "updates": {
    "mode": "notify",
    "channel": "stable",
    "feedUrl": "https://updates.corp.example/restura",
    "requestHeaderEnv": {
      "Authorization": "RESTURA_UPDATE_AUTHORIZATION"
    },
    "minimumVersion": "1.8.0"
  },
  "telemetry": {
    "errorReporting": false,
    "agentTelemetry": false
  },
  "ai": {
    "enabled": true,
    "providers": ["openai"],
    "baseOrigins": ["https://api.openai.com"]
  },
  "features": {
    "git": true,
    "gitSsh": false,
    "mcp": true,
    "importExport": true,
    "mockCapture": false,
    "kafka": false,
    "mqtt": false
  }
}
```

Proxy and update credentials are never embedded in the policy. The named
environment variables are resolved in the Electron main process only.

## Network modes

- `system` uses Electron's operating-system proxy configuration.
- `fixed` uses `proxyUrl`.
- `pac` loads the HTTPS `pacUrl` through Electron and resolves its result before
  app-owned transports connect.
- `direct` disables managed proxy routing and cannot be combined with
  `requireProxy: true`.

When `requireProxy` is true, a `DIRECT` PAC/system result is rejected unless the
destination matches `bypassList`. HTTP and HTTPS proxies are supported across
HTTP, GraphQL, WebSocket, Socket.IO, SSE, MCP, AI, gRPC, Git HTTPS, and the
managed update feed.

Fixed-proxy authentication supports **Basic** credentials supplied by
environment references. Credentials are rejected for system and PAC modes so
they cannot be disclosed to an unexpected dynamically resolved proxy. NTLM,
Kerberos, Negotiate, and interactive authentication are not
implemented. Enterprises requiring those schemes should place an approved
local forward proxy in front of them or use an operating-system proxy setup
that does not expose interactive credentials to Restura.

SOCKS remains available as a user desktop setting when the app is unmanaged,
but managed fixed-proxy policy accepts HTTP(S) proxy URLs only.

Kafka, MQTT, and Git SSH use raw protocols that an HTTP proxy cannot carry.
They are blocked when `requireProxy` is true unless the protocol is explicitly
listed in `network.directProtocols`. Feature flags must allow the feature too.

## TLS trust

Managed mode always verifies certificates and permits a minimum of TLS 1.2 or
TLS 1.3. Users cannot turn verification off or lower the TLS floor.

`caCertificatePaths` is a bounded PEM bundle used by Restura-owned Node
transports. Install the same roots in the operating-system trust store for
Chromium, Electron's updater, PAC download, and other OS-owned connections.
Restura does not install or mutate system trust.

## Updates

Managed updates use an HTTPS generic electron-updater feed and never fall back
to GitHub Releases. Supported modes are:

- `disabled`
- `notify`
- `auto-download`
- `install-on-quit`

`stable` and `beta` channels are supported. Header names are limited to
`Authorization` and `X-*`; values come from environment variables. If
`minimumVersion` is set and the installed version is older, normal outbound
work is blocked while update access remains available.

The feed must contain the platform artifacts and metadata expected by
electron-updater. Mirror the complete release set rather than only the
installer. Validate its code signature and update metadata in a pilot ring.

## Feature and destination controls

The feature flags control Git, Git SSH, MCP (including headless MCP-server
mode), native Bruno directory export, local mock/capture, Kafka, and MQTT.
Browser-local import and JSON download transformations do not cross the main
process and are not an enterprise security boundary. AI additionally requires
an enabled provider and an exact allowed HTTPS origin. Error reporting and
agent telemetry can only be disabled by policy; user consent is still required
when policy permits them.

Managed settings are shown read-only in the renderer. Enforcement remains in
the Electron main process so renderer state cannot bypass it.

## Diagnostics and rollback

Settings displays only redacted status: source type, network mode, update mode,
proxy requirement, and minimum-version state. It never returns policy JSON,
credential environment names, headers, CA contents, or secrets to the renderer.

An invalid policy blocks outbound operations and leaves Settings available for
diagnosis. Correct or remove the selected machine policy and restart Restura.
Removing every policy source restores the normal unmanaged desktop behavior.

Application logs contain policy state and sanitized failures. Do not collect
user profiles wholesale; request only the relevant log entries.

## Known rollout boundaries

- Windows production packages require your signing certificate. Unsigned
  builds are unsuitable for broad managed deployment.
- The desktop policy does not apply to the web or self-hosted targets.
- There is no enterprise SSO, RBAC, central audit log, or shared server-side
  workspace.
- Browser and self-hosted SPA data is local to each browser profile and is
  plaintext in IndexedDB unless protected by endpoint/browser controls.
- Browser-local collection imports and JSON downloads are not disabled by
  desktop managed policy.
- Deploy a single self-hosted replica unless an external distributed
  rate-limiter is added.
