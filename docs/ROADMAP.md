# Restura — Roadmap

## Current Status: v0.1.0

Core functionality is complete and shipping. Web (Cloudflare Pages) and desktop (Electron) apps are both available.

---

## Shipped ✅

### Core API Client

- [x] HTTP Request Builder (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD)
- [x] Query parameters with enable/disable toggle
- [x] Custom headers management
- [x] Body types: JSON, XML, form-data, x-www-form-urlencoded, raw, binary
- [x] Authentication: Basic, Bearer, API Key, OAuth2, Digest, AWS Signature v4, mTLS
- [x] Environment variables with `{{variable}}` substitution
- [x] Collections and folder hierarchy
- [x] Import: Postman v2.1, Insomnia, OpenAPI/Swagger
- [x] Export: Postman v2.1, Insomnia
- [x] Code generation: cURL, JS, Python, Go, Ruby, PHP
- [x] Response viewer with Monaco Editor syntax highlighting
- [x] Request history with favorites
- [x] Dark/Light/System theme
- [x] Pre-request and test scripts (QuickJS sandbox)
- [x] Electron desktop app (macOS, Windows, Linux)
- [x] Web client on Cloudflare Pages + Workers
- [x] Proxy support with mTLS and proxy chaining
- [x] Cookie management
- [x] Command palette

### Extended Protocols

- [x] gRPC unary calls
- [x] gRPC server streaming
- [x] gRPC server reflection
- [x] WebSocket connection management with message history
- [x] GraphQL query builder with schema introspection
- [x] GraphQL subscriptions
- [x] Server-Sent Events (SSE) client
- [x] Model Context Protocol (MCP) client

### Workflows

- [x] Request chaining with sequential execution
- [x] Variable extraction: JSONPath, regex, response headers
- [x] Precondition scripts for conditional step execution
- [x] Retry policies: fixed delay, exponential backoff
- [x] Real-time execution progress and logging
- [x] Visual workflow builder

---

## In Progress 🔄

- [ ] Test coverage improvement (target: 80%)
- [ ] gRPC client streaming and bidirectional streaming
- [ ] Accessibility improvements (WCAG 2.1 AA)

---

## Planned

Features below are planned but not yet scheduled. Contributions welcome.

### Collaboration & Cloud Sync

- [ ] Cloud storage for collections
- [ ] Sync across devices
- [ ] Conflict resolution
- [ ] Shared workspaces
- [ ] Team collections with role-based access
- [ ] Comments on requests
- [ ] Version history for collections

### Import & Export Expansion

- [ ] cURL import
- [ ] HAR import
- [ ] Environment export
- [ ] OpenAPI export

### Auth Improvements

- [ ] OAuth 2.0 Authorization Code + PKCE flows
- [ ] Token auto-refresh
- [ ] Collection-level auth inheritance

### Testing & Automation

- [ ] Test suites with HTML/JUnit reports
- [ ] Scheduled test runs
- [ ] Mock servers
- [ ] CI/CD integration guide

### Performance Testing

- [ ] Load testing (ghz integration for gRPC)
- [ ] Performance metrics visualization

### Plugin System

- [ ] Plugin architecture for custom auth, code gen, and importers
- [ ] Plugin marketplace

---

## Long-term Vision

### IDE Integration

- [ ] VS Code extension
- [ ] JetBrains plugin
- [ ] In-editor request execution

### Browser Extension

- [ ] Chrome / Firefox extension
- [ ] Capture requests from DevTools

### Enterprise

- [ ] Single Sign-On (SSO)
- [ ] Audit logging
- [ ] Data residency options

### AI Features

- [ ] AI-assisted request building
- [ ] Smart test generation
- [ ] Natural language to API call

---

## Contributing

Pick up any open issue or propose a new feature via the [feature request template](https://github.com/dipjyotimetia/restura/issues/new?template=feature_request.md).

See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to get started.

---

*Last updated: May 2026*
