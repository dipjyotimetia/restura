# Security Policy

## Supported Versions

Security fixes land on `main` and ship in the next release. Only the latest release of each component — web app, desktop app, self-hosted server, `restura-cli`, and the browser/VS Code extensions — receives security updates; upgrade before reporting an issue against an older build.

| Version                          | Supported          |
| -------------------------------- | ------------------ |
| Latest release of each component | :white_check_mark: |
| Anything older                   | :x:                |

## Reporting a Vulnerability

We take the security of Restura seriously. If you have discovered a security vulnerability, please follow these steps:

### 1. Do NOT Open a Public Issue

Security vulnerabilities should not be reported through public GitHub issues.

### 2. Report Privately on GitHub

Use GitHub's private vulnerability reporting: [open a private security advisory](https://github.com/dipjyotimetia/restura/security/advisories/new). Include:

- **Subject**: [SECURITY] Brief description of the vulnerability
- **Description**: Detailed description of the vulnerability
- **Impact**: What could an attacker accomplish?
- **Steps to Reproduce**: Clear steps to reproduce the issue
- **Affected Versions**: Which versions are affected
- **Suggested Fix**: If you have a suggestion (optional)

### 3. Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 5 business days
- **Fix Timeline**: Depends on severity (see below)

### 4. Severity Levels

| Severity | Description                                 | Response Time |
| -------- | ------------------------------------------- | ------------- |
| Critical | Remote code execution, data breach          | 24-48 hours   |
| High     | Authentication bypass, privilege escalation | 3-5 days      |
| Medium   | XSS, CSRF, information disclosure           | 1-2 weeks     |
| Low      | Minor information exposure                  | Next release  |

## Verifying downloads

Official Restura artifacts come only from these places. Treat anything else, including lookalike sites and re-hosted installers, as untrusted:

- [github.com/dipjyotimetia/restura/releases](https://github.com/dipjyotimetia/restura/releases) (desktop installers, SBOMs, extension packages)
- `ghcr.io/dipjyotimetia/restura` (Docker image)
- [npmjs.com/package/restura-cli](https://www.npmjs.com/package/restura-cli) (CLI)
- [restura.dev](https://restura.dev)

The commands below use the [GitHub CLI](https://cli.github.com/) (`gh`), which verifies signed attestations against GitHub's records. For how the release pipeline protects these artifacts, and what to do if one is compromised, see [docs/SUPPLY_CHAIN_HARDENING.md](docs/SUPPLY_CHAIN_HARDENING.md).

### Desktop installers

Every installer (`.dmg`, `.zip`, `.exe`, `.AppImage`, `.deb`, `.rpm`) on a GitHub release has a SLSA build provenance attestation, created by the `attest-desktop` job of `.github/workflows/release.yml`:

```bash
gh attestation verify <downloaded-file> --repo dipjyotimetia/restura
```

A successful check proves the file was built by that workflow in this repository and has not been altered since.

**macOS** installers are also code signed and notarized. After copying the app to `/Applications`:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Restura.app
spctl --assess --type execute --verbose /Applications/Restura.app
```

`codesign` should report that the app is valid on disk and satisfies its Designated Requirement. `spctl` should report `accepted` with `source=Notarized Developer ID`. The signing identity is a "Developer ID Application" certificate; each release's notes list the expected identity.

**Windows** installers are currently **not** Authenticode-signed (Windows signing is optional until a certificate is added), so SmartScreen may warn about them. Rely on the `gh attestation verify` check above before running an installer.

### Docker image

```bash
gh attestation verify oci://ghcr.io/dipjyotimetia/restura:<version> --repo dipjyotimetia/restura
```

Tags can move; digests cannot. Pin deployments by digest (`ghcr.io/dipjyotimetia/restura@sha256:...`) and verify before upgrading. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#pinning-and-verifying-the-image).

### npm CLI (`restura-cli`)

`restura-cli` is published from `.github/workflows/release.yml` through npm trusted publishing (OIDC) with provenance, so there is no long-lived npm token. To check a version:

```bash
npm view restura-cli@<version> --json | jq .dist.attestations
```

In a project that depends on it, `npm audit signatures` verifies the registry signatures and provenance attestations of all installed packages. The npmjs.com package page also shows a "Provenance" badge linking to the exact workflow run and commit.

### SBOM

Every GitHub release attaches a CycloneDX SBOM of the production dependency tree as `restura.cdx.json` and `restura.cdx.xml`. Use it to check whether a release is affected by a CVE:

```bash
# Is a given package (and which version) in this release?
jq -r '.components[] | "\(.name)@\(.version)"' restura.cdx.json | grep '^<package>@'
```

or feed it to an SBOM scanner, for example:

```bash
grype sbom:restura.cdx.json
osv-scanner --sbom=restura.cdx.json
```

These scanners are examples; any tool that reads CycloneDX works.

### VS Code and Chrome extensions

Install the extensions only from the official Visual Studio Marketplace, Open VSX or Chrome Web Store listings linked from this repository. The VS Code publisher id is `dipjyotimetia`. The `.vsix` and `.zip` files attached to `vscode-v*` and `chrome-v*` GitHub releases are the same bytes uploaded to the stores.

## Security Best Practices

### For Users

1. **Keep Updated**: Always use the latest version
2. **Environment Variables**: Never commit sensitive data
3. **Authentication**: Use strong authentication methods
4. **Network Security**: Use HTTPS for all API requests
5. **Electron Desktop**: Only install from official sources

### For Developers

1. **Input Validation**: Always validate and sanitize user input
2. **Dependencies**: Keep all dependencies updated
3. **Secrets Management**: Never hardcode secrets
4. **Error Handling**: Don't expose sensitive information in errors
5. **Code Review**: All security-sensitive code must be reviewed

## Security Features

### Frontend Security

- **Content Security Policy (CSP)**: Strict CSP headers configured
- **XSS Protection**: React's built-in escaping + additional sanitization
- **Input Validation**: Zod schemas for runtime type checking
- **Secure Storage**: Sensitive data stored in IndexedDB (web, via Dexie) or encrypted electron-store sealed by the OS keychain (desktop); the legacy localStorage adapter has been removed
- **CORS**: Proper cross-origin resource sharing configuration

### Electron Security

- **Context Isolation**: Enabled by default
- **Node Integration**: Disabled in renderer process
- **Preload Scripts**: Secure IPC communication with channel validation
- **Remote Module**: Disabled
- **WebSecurity**: Always enabled (even in development)
- **Sandbox**: Renderer process sandboxed
- **File Operations**: Path validation prevents path traversal attacks
- **File Size Limits**: 50MB maximum for file operations
- **Content Security Policy**: Strict CSP without unsafe-eval; `object-src 'none'` and `worker-src 'self' file:` pinned, enforced identically as a response header (`electron/main/main.ts`) and a `<meta>` fallback (`vite.config.mts`) with a structural test guarding their parity
- **Web Permissions**: Default-deny — `setPermissionRequestHandler`/`setPermissionCheckHandler` reject every web permission except `clipboard-sanitized-write`
- **macOS Notarization**: Enabled for signed releases
- **Hardened Runtime**: Enabled on macOS

### Backend Security

- **Input Validation**: All inputs validated
- **Authentication**: OAuth2, API keys, JWT support
- **Rate Limiting**: Protection against abuse
- **Dependency Scanning**: Regular vulnerability scans

## Known Security Considerations

### Script Execution

Restura allows users to write pre-request and test scripts. These scripts are executed in a **true sandboxed QuickJS environment** with:

- **Complete isolation**: QuickJS WebAssembly runtime (no access to host JavaScript)
- **No file system access**: Scripts cannot read/write files
- **No direct network access**: No `fetch`/`XMLHttpRequest`; the only network path is the host-mediated `pm.sendRequest`/`rs.sendRequest`, which goes through the same SSRF-guarded proxy as a normal send
- **Limited API surface**: Only safe JavaScript APIs plus a fixed, bundled library set (`require` cannot reach npm or Node core modules)
- **Timeout enforcement**: 5-second maximum for synchronous scripts; 30 seconds when a host bridge (`sendRequest`, vault, cookies) is in use
- **Memory limits**: 64 MB per script runtime, plus a pinned native stack ceiling

### URL Validation & SSRF Protection

Restura implements comprehensive URL validation to prevent Server-Side Request Forgery (SSRF) attacks:

- **Scheme validation**: Only HTTP/HTTPS URLs allowed
- **Private IP blocking**: Internal network ranges (10.x.x.x, 192.168.x.x, etc.) blocked by default
- **Metadata service protection**: Cloud metadata endpoints (169.254.169.254) blocked
- **Configurable localhost**: Localhost access can be enabled/disabled per environment
- **URL sanitization**: Credentials and potentially malicious content removed

### Data Storage

- **Collections**: Stored in browser IndexedDB (via Dexie) on web, or encrypted electron-store on desktop
- **Environment Variables**: Stored locally, can contain sensitive data
- **Request History**: Stored locally
- **Credentials**: On desktop, secret-bearing auth fields use `SecretRef` handles — plaintext lives only in the main-process handle store (electron-store sealed via `safeStorage`/OS keychain) and is resolved at wire-signing time, never in the renderer (ADR-0007)
- **Encryption available**: `src/lib/shared/encryption.ts` provides AES-GCM helpers used by the encrypted Dexie storage adapter

**Security Features**:

- Web Crypto API for AES-GCM encryption
- PBKDF2 key derivation (100,000 iterations)
- Random salt and IV per encryption operation

**Recommendation**: Be cautious with sensitive data in requests. Consider using environment variables for secrets and clearing history regularly. Store desktop credentials as secret handles rather than inline values.

### Proxy Support

Restura supports proxy configuration which can be used to route requests through corporate proxies or testing tools. Be aware that:

- Proxy settings can intercept all requests
- Credentials may be visible to proxy servers
- Use trusted proxy servers only

## Third-Party Dependencies

We regularly monitor and update our dependencies for known vulnerabilities:

### Frontend Dependencies

- React, Vite, and core libraries are kept up-to-date
- Radix UI primitives for accessible components
- Monaco Editor for code editing
- Regular `npm audit` checks

### Worker Dependencies

- Hono and Node.js-compatible libraries kept up-to-date
- Regular `npm audit` checks
- Minimal dependency footprint

## Security Audits

We perform regular security reviews:

- **Automated**: Dependabot version updates, dependency review on every pull request, a scheduled `npm audit` workflow (`security-audit.yml`), and OpenSSF Scorecard
- **Manual**: Periodic code reviews focusing on security
- **External**: Open to responsible security researchers

## Disclosure Policy

We follow responsible disclosure:

1. **Report received**: Acknowledged within 48 hours
2. **Triage**: Severity assessed within 5 days
3. **Fix development**: Based on severity timeline
4. **Testing**: Thorough testing of the fix
5. **Release**: Security patch released
6. **Advisory**: Public security advisory published
7. **Credit**: Reporter credited (unless anonymity requested)

## Security Updates

Security updates are distributed through:

- **GitHub Releases**: [Release notes](https://github.com/dipjyotimetia/restura/releases) are the changelog; a release with security fixes says so at the top and lists any breaking changes
- **npm**: Updated `restura-cli` published
- **Advisories**: [GitHub Security Advisories](https://github.com/dipjyotimetia/restura/security/advisories), which Dependabot uses to alert `restura-cli` users
- **Docker**: the self-hosted image on GHCR is published for a release only when that release opts in, so check its release notes before relying on a matching tag

## Compliance

Restura aims to follow security best practices:

- **OWASP Top 10**: Protection against common vulnerabilities
- **WCAG 2.1**: Accessibility compliance
- **GDPR**: Crash reporting is opt-out and carries no request data or URLs. Desktop session health carries a random install ID (not derived from the device or user, never attached to error reports, deleted on opt-out) and no IP; see [ADR 0040](docs/adr/0040-random-install-id-for-release-health.md)
- **SOC 2**: Security controls in development

## Security-Related Configuration

### Environment Variables

```bash
# Never commit these to version control
GITHUB_TOKEN=your-token
API_KEY=your-key
```

### .gitignore Best Practices

```
# Environment files
.env
.env.local
.env.*.local

# Credentials
*.pem
*.key
*.cert
credentials.json

# IDE
.vscode/settings.json
.idea/
```

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)

## Contact

For security-related inquiries:

- GitHub: [open a private security advisory](https://github.com/dipjyotimetia/restura/security/advisories/new)

Thank you for helping keep Restura and its users safe!
