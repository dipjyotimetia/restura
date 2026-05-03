# Restura

Fast, lightweight API client supporting REST, GraphQL, gRPC, WebSockets, SSE, and MCP. Built for developers who value speed and simplicity.

**Restura** is a full-featured API client that makes testing and debugging APIs effortless. Whether you're working with REST, GraphQL, gRPC, WebSockets, Server-Sent Events, or MCP servers, Restura provides an intuitive interface with powerful features that developers actually need.

## Features

- **Multi-protocol support**: HTTP/REST, GraphQL, gRPC, WebSockets, SSE, and MCP
- **Privacy-first**: Your data stays on your machine (localStorage persistence, no external sync)
- **Dual delivery**: Web app (Cloudflare Pages) and desktop app (Electron)
- **Script sandbox**: Pre-request and test scripts running in an isolated QuickJS VM
- **Request chaining**: Workflows with variable extraction and retry policies
- **Import/Export**: Postman v2.1, Insomnia, and OpenAPI/Swagger collections
- **Code generation**: cURL, JavaScript, Python, Go, and more
- **Environment variables**: `{{variable}}` substitution with scoped environments
- **Authentication**: Basic, Bearer, API Key, OAuth2, Digest, AWS Signature v4, mTLS
- **Cross-platform**: macOS, Windows, and Linux desktop builds
- **Forever free**: No premium tiers, no feature gates

## Quick Start

### Prerequisites

- Node.js 22+
- npm

### Web Client

```bash
git clone https://github.com/dipjyotimetia/restura.git
cd restura

npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

The Vite dev server also boots the Cloudflare Worker locally via Miniflare — a single command starts both the SPA and the Worker proxy.

### Desktop App

```bash
# Development mode (starts Vite + Electron simultaneously)
npm run electron:dev

# Production builds
npm run electron:dist:mac    # macOS (DMG + ZIP, x64 + arm64)
npm run electron:dist:win    # Windows (NSIS installer + portable)
npm run electron:dist:linux  # Linux (AppImage + deb + rpm)
```

## Development Scripts

### Web Client

```bash
npm run dev              # Start Vite dev server + Cloudflare Worker (port 5173)
npm run build            # Production build (SPA + Worker bundle)
npm run preview          # Preview production build
npm run type-check       # TypeScript strict check
npm run lint             # ESLint
npm run lint:fix         # ESLint with auto-fix
npm run format           # Prettier
npm run format:check     # Prettier check (CI)
npm run validate         # type-check + lint + test:run (full CI check)
```

### Testing

```bash
npm run test             # Vitest interactive mode
npm run test:run         # Single run (CI)
npm run test:watch       # Watch mode
npm run test:coverage    # Coverage report
npm run test:ui          # Vitest UI browser
```

### Electron Desktop

```bash
npm run electron:dev           # Dev: Vite + Electron simultaneously
npm run electron:compile       # Compile main process TypeScript
npm run electron:build:web     # Build renderer for Electron packaging
npm run electron:dist:mac      # Build macOS installer
npm run electron:dist:win      # Build Windows installer
npm run electron:dist:linux    # Build Linux packages
```

### Cloudflare Pages Deployment

```bash
npm run deploy           # Build + deploy production
npm run deploy:preview   # Build + deploy preview branch
```

### Worker Type-Check

```bash
npx tsc --noEmit -p worker/tsconfig.json
```

## Architecture

### Dual-Platform Design

The renderer (SPA) is identical for both delivery targets. What changes is how protocol requests are handled:

- **Web**: Requests route through a Hono Worker on Cloudflare Pages Functions (`/api/proxy`, `/api/grpc`, etc.)
- **Desktop**: Requests go through Electron IPC to native Node.js handlers in the main process

The renderer's `requestExecutor`, `grpcClient`, and other clients branch on `isElectron()` to choose the right transport. The Worker is never bundled into the Electron app.

```
Browser ──► Vite SPA ──► Cloudflare Worker (Hono) ──► Target API
Electron ──► Vite SPA ──► Electron IPC ──► Native handlers ──► Target API
```

### State Management

All stores use Zustand with `persist` middleware:

| Store | Purpose |
|---|---|
| `useRequestStore` | Current request/response state |
| `useCollectionStore` | Saved request collections |
| `useEnvironmentStore` | Environment variables |
| `useHistoryStore` | Request history |
| `useSettingsStore` | App preferences |
| `useWorkflowStore` | Request chaining workflows |

### Script Execution

Pre-request and test scripts execute in an isolated QuickJS WASM sandbox (`src/features/scripts/lib/scriptExecutor.ts`). Scripts cannot access the DOM or make direct network requests.

## Code Quality

- **TypeScript**: Strict mode with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noUncheckedIndexedAccess`
- **ESLint**: TypeScript + React rules
- **Prettier**: Consistent formatting
- **Husky + lint-staged**: Pre-commit formatting

## CI/CD

GitHub Actions runs on every PR and push to `main`:

1. Type-check renderer, Electron main process, and Worker
2. Lint
3. Security audit (`npm audit --audit-level=critical`)
4. Tests
5. Build renderer and Electron main process
6. Deploy to Cloudflare Pages (production on `main`, preview on PRs)

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System design and component details
- [Changelog](docs/CHANGELOG.md) - Version history
- [Roadmap](docs/ROADMAP.md) - Planned features
- [Contributing](CONTRIBUTING.md) - Contribution guidelines
- [Security](SECURITY.md) - Security policy
- [Code of Conduct](CODE_OF_CONDUCT.md) - Community guidelines

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Security

For security concerns, review our [Security Policy](SECURITY.md) and report vulnerabilities responsibly.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- [shadcn/ui](https://ui.shadcn.com/) — UI components built on Radix UI
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — Code editor
- [Radix UI](https://www.radix-ui.com/) — Accessible primitives
- [Zustand](https://github.com/pmndrs/zustand) — State management
- [Hono](https://hono.dev/) — Cloudflare Worker framework
- [QuickJS](https://bellard.org/quickjs/) — Embedded JS engine for script sandboxing

---

Made by [dipjyotimetia](https://github.com/dipjyotimetia)
