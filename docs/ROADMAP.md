# Restura - Product Roadmap

This document outlines the planned features and improvements for Restura.

## Current Status: v0.1.0 (Beta)

Core functionality complete with web and desktop applications.

---

## Q1 2025 - Foundation & Stability

### Completed Features ✅

- [x] HTTP Request Builder (all methods)
- [x] Query Parameters with enable/disable
- [x] Custom Headers management
- [x] Multiple body types (JSON, XML, Form Data, etc.)
- [x] Authentication support (Basic, Bearer, API Key, OAuth2, Digest, AWS Sig v4)
- [x] Environment variables with substitution
- [x] Collections and folders
- [x] Import/Export (Postman v2.1, Insomnia)
- [x] Code generation (cURL, JS, Python, Go, etc.)
- [x] Response viewer with syntax highlighting
- [x] Request history with favorites
- [x] Dark/Light theme support
- [x] Pre-request and test scripts
- [x] Electron desktop application
- [x] Proxy support
- [x] Command palette

### In Progress 🔄

- [ ] Complete gRPC support
  - [ ] Unary calls
  - [ ] Server streaming
  - [ ] Client streaming
  - [ ] Bidirectional streaming
  - [ ] Reflection support
- [ ] Improved test coverage (target: 80%)
- [ ] Performance optimizations
- [ ] Accessibility improvements (WCAG 2.1 AA)

---

## Q2 2025 - Enhanced Protocol Support

### WebSocket Support

- [ ] WebSocket connection management
- [ ] Message sending and receiving
- [ ] Connection state visualization
- [ ] Message history
- [ ] Auto-reconnection
- [ ] Binary message support

### GraphQL Support

- [ ] GraphQL query builder
- [ ] Schema introspection
- [ ] Variable support
- [ ] Subscription support
- [ ] Query history
- [ ] Auto-completion

### Server-Sent Events (SSE)

- [ ] SSE connection management
- [ ] Event stream visualization
- [ ] Reconnection handling
- [ ] Event filtering

---

## Q3 2025 - Collaboration & Cloud

### Cloud Sync (Basic)

- [ ] User authentication
- [ ] Cloud storage for collections
- [ ] Sync across devices
- [ ] Conflict resolution
- [ ] Offline support
- [ ] Encryption at rest

### Team Collaboration

- [ ] Shared workspaces
- [ ] Team collections
- [ ] Role-based access control
- [ ] Activity history
- [ ] Comments on requests
- [ ] Version control for collections

### API Documentation

- [ ] Auto-generate documentation
- [ ] OpenAPI/Swagger export
- [ ] Markdown export
- [ ] Interactive documentation
- [ ] Share public documentation

---

## Q4 2025 - Advanced Features

### Performance Testing

- [ ] Load testing (integrated with ghz)
- [ ] Performance metrics visualization
- [ ] Grafana dashboard integration
- [ ] Custom metrics
- [ ] Performance history
- [ ] Alerting

### Automated Testing

- [ ] Test suites
- [ ] Scheduled test runs
- [ ] CI/CD integration
- [ ] Test reports
- [ ] Assertions library
- [ ] Mock servers

### Plugin System

- [ ] Plugin architecture
- [ ] Official plugin marketplace
- [ ] Custom authentication plugins
- [ ] Code generator plugins
- [ ] Import/Export format plugins
- [ ] UI customization plugins

---

## 2026 - Enterprise & Scale

### Enterprise Features

- [ ] Single Sign-On (SSO)
- [ ] LDAP/Active Directory integration
- [ ] Audit logging
- [ ] Compliance reporting
- [ ] Data residency options
- [ ] Priority support

### Advanced Security

- [ ] Secrets manager integration
- [ ] Certificate management
- [ ] mTLS support
- [ ] Security scanning
- [ ] Vulnerability detection
- [ ] OWASP compliance checking

### AI-Powered Features

- [ ] AI-assisted request building
- [ ] Smart test generation
- [ ] Natural language to API calls
- [ ] Response analysis
- [ ] Performance recommendations
- [ ] Documentation generation

---

## Long-term Vision

### Mobile Applications

- [ ] iOS native app
- [ ] Android native app
- [ ] Tablet-optimized UI
- [ ] Offline capabilities
- [ ] Sync with desktop

### Browser Extension

- [ ] Chrome extension
- [ ] Firefox extension
- [ ] Capture requests from browser
- [ ] Quick request sending
- [ ] Sync with main app

### IDE Integration

- [ ] VS Code extension
- [ ] JetBrains plugin
- [ ] Neovim plugin
- [ ] In-editor request execution
- [ ] Code generation integration

---

## Feature Requests

Have a feature request? Please [open an issue](https://github.com/dipjyotimetia/restura/issues/new?template=feature_request.md) with the feature request template.

## Contributing

Want to help build these features? Check out our [Contributing Guidelines](../CONTRIBUTING.md) and pick up an issue to work on!

---

## Release Schedule

- **Patch releases**: As needed for bug fixes
- **Minor releases**: Monthly with new features
- **Major releases**: Quarterly with breaking changes

## Versioning

Restura follows [Semantic Versioning](https://semver.org/):
- MAJOR version for incompatible API changes
- MINOR version for new functionality
- PATCH version for bug fixes

---

Last updated: November 2025
