# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Restura is a multi-protocol API testing client supporting HTTP/REST, GraphQL, gRPC, and WebSockets. It runs as both a Next.js web application and an Electron desktop app.

## Development Commands

```bash
# Web development
npm run dev                    # Start Next.js dev server (Turbopack)
npm run build                  # Production build
npm run type-check             # TypeScript type checking (strict mode)
npm run lint                   # TypeScript validation
npm run format                 # Prettier formatting

# Testing
npm run test                   # Vitest interactive mode
npm run test:run               # Single test run
npm run test:watch             # Watch mode
npm run test:coverage          # Coverage report
npm run test:ui                # Vitest UI

# Full validation (CI pipeline)
npm run validate               # type-check + lint + test:run

# Electron desktop app
npm run electron:dev           # Dev mode (web + Electron)
npm run electron:compile       # Compile TypeScript for main process
npm run electron:dist:mac      # Build macOS app
npm run electron:dist:win      # Build Windows app
npm run electron:dist:linux    # Build Linux app
```

## Architecture

### Dual-Platform Design
- **Web Client**: Next.js 16 App Router at `src/app/`
- **Desktop Client**: Electron main process at `electron/main/`
- Shared renderer code organized by feature in `src/features/`

### Feature-Based Organization
Code is organized by feature for better scalability:
```
src/features/
├── http/           # RequestBuilder, requestExecutor, useHttpRequest, useCookieStore
├── grpc/           # GrpcRequestBuilder, grpcClient, grpcReflection
├── websocket/      # WebSocketClient
├── collections/    # Sidebar, CollectionRunner, importers, exporters
├── environments/   # EnvironmentManager
├── auth/           # AuthConfig (shared by HTTP & gRPC)
└── scripts/        # ScriptsEditor, scriptExecutor

src/components/
├── ui/             # Radix UI primitives (shadcn/ui patterns)
├── shared/         # Header, ResponseViewer, KeyValueEditor, CodeEditor, etc.
└── providers/      # PlatformProvider, ThemeProvider

src/lib/shared/     # utils, encryption, storage, platform, validations
```

### State Management (Zustand)
Four persisted stores manage application state:
- `useRequestStore` - Current request/response state
- `useCollectionStore` - Saved request collections
- `useEnvironmentStore` - Environment variables
- `useHistoryStore` - Request history
- `useSettingsStore` - App preferences

All stores use `zustand/middleware/persist` for localStorage persistence. Stores are validated with Zod schemas in `src/lib/shared/store-validators.ts`.

### Request Type System
The app handles multiple protocols through a discriminated union pattern:
```typescript
type Request = HttpRequest | GrpcRequest;  // src/types/index.ts:145
```

Each request type has its own builder component in its feature folder (`src/features/http/components/RequestBuilder` for HTTP, `src/features/grpc/components/GrpcRequestBuilder` for gRPC).

### Electron IPC Architecture
Main process modules are separated by concern in `electron/main/`:
- `main.ts` - Application entry, orchestrates other modules
- `window-manager.ts` - Window creation and management
- `file-operations.ts` - Native file system access
- `http-handler.ts` - Native HTTP requests
- `auto-updater.ts` - App updates via electron-updater
- `preload.ts` - Secure bridge between main/renderer

IPC handlers are registered centrally in `registerIPCHandlers()`.

### Key Technical Patterns

**Path Alias**: All imports use `@/` prefix mapping to `./src/` (configured in tsconfig.json and vitest.config.ts)

**Type Safety**: Strict TypeScript with additional checks:
- `noUnusedLocals`, `noUnusedParameters`
- `noImplicitReturns`, `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes` disabled for flexibility

**UI Components**: Built on Radix UI primitives with custom styling via Tailwind CSS 4. Components in `src/components/ui/` follow shadcn/ui patterns.

**Script Execution**: Pre-request and test scripts run in QuickJS sandbox (`src/features/scripts/lib/scriptExecutor.ts`) for security isolation.

**Import/Export**: Supports Postman and Insomnia collection formats via `src/features/collections/lib/importers.ts` and `src/features/collections/lib/exporters.ts`.

## Testing

Tests are colocated with source files using `*.test.ts` pattern:
- `src/features/*/lib/__tests__/` - Feature-specific tests (HTTP, gRPC, scripts, etc.)
- `src/lib/shared/__tests__/` - Shared utility tests
- `src/store/__tests__/` - Store logic tests

Test setup is in `tests/setup.ts`. Vitest runs in jsdom environment with React Testing Library.

## Electron Build

Electron configuration is in `electron-builder.json`. The build process:
1. `electron:build:next` - Static export with `ELECTRON_BUILD=true`
2. `electron:compile` - Compiles TypeScript in `electron/main/`
3. `electron-builder` - Packages app for target platform

Electron main process has its own `tsconfig.json` at `electron/tsconfig.json`.
