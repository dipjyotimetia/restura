# Changelog

All notable changes to Restura will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Request Chaining & Workflows** - Execute requests sequentially with data passing between them
  - Create and manage workflows within collections
  - Add steps from existing requests in your collection
  - Variable extraction from responses using:
    - JSONPath (dot notation): `data.user.id`, `items[0].name`
    - Regex with capture groups: `"token":"([^"]+)"`
    - Response headers: `X-Request-Id`, `Authorization`
  - Precondition scripts for conditional step execution
  - Retry policies with configurable attempts, delay, and exponential backoff
  - Real-time execution progress and logging
  - Execution history tracking
  - Visual workflow builder with step management
  - Live extraction testing/preview
  - New "Workflows" tab in sidebar
  - Full TypeScript support with Zod validation
  - Comprehensive test coverage (43 tests)

### Technical Details

- New store: `useWorkflowStore` with localStorage persistence
- New hook: `useWorkflowExecution` for React components
- New components: `WorkflowManager`, `WorkflowBuilder`, `WorkflowExecutor`, `WorkflowStep`, `VariableExtractorConfig`
- New library functions: `executeWorkflow`, `extractVariables`, `testExtraction`
- Types: `Workflow`, `WorkflowRequest`, `VariableExtraction`, `WorkflowExecution`, `WorkflowExecutionStep`

## [0.1.0] - 2024-XX-XX

### Added

- Initial release of Restura
- HTTP/REST request builder with all methods (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD)
- gRPC client with reflection support
- Environment variables with `{{variable}}` syntax
- Collections for organizing requests
- Request history with favorites
- Pre-request and test scripts (QuickJS sandbox)
- Code generation (cURL, JavaScript, Python, Go, etc.)
- Import/Export support:
  - Postman collections
  - Insomnia collections
  - OpenAPI/Swagger specifications
- Authentication methods:
  - Basic Auth
  - Bearer Token
  - API Key
  - OAuth2
  - Digest Auth
  - AWS Signature
- Proxy configuration
- Cookie management
- Response viewer with syntax highlighting
- Dark/Light theme support
- Desktop app (Electron) for macOS, Windows, Linux
- Web client (Next.js)

---

## Version History Format

Each version entry includes:

- **Added** - New features
- **Changed** - Changes in existing functionality
- **Deprecated** - Soon-to-be removed features
- **Removed** - Removed features
- **Fixed** - Bug fixes
- **Security** - Vulnerability fixes
