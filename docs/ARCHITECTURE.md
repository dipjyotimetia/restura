# Restura - Architecture Documentation

## Overview

Restura is a modern, full-stack API testing tool similar to Postman, designed for HTTP and gRPC testing. The application features both web and desktop (Electron) delivery options.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                           Restura                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────┐       ┌────────────────────────────┐  │
│  │   Web Application   │       │    Desktop Application     │  │
│  │   (Next.js 16)      │       │    (Electron + Next.js)    │  │
│  └──────────┬──────────┘       └─────────────┬──────────────┘  │
│             │                                 │                 │
│             └─────────────┬───────────────────┘                 │
│                           │                                     │
│              ┌────────────▼────────────┐                        │
│              │   React 19 Frontend     │                        │
│              │   (Shared Codebase)     │                        │
│              └─────────────────────────┘                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Technology Stack

### Frontend (Web Client)
- **Framework**: Next.js 16 (App Router with Turbopack)
- **UI Library**: React 19
- **Styling**: TailwindCSS v4 + PostCSS
- **UI Components**: shadcn/ui (Radix UI primitives)
- **State Management**: Zustand with localStorage persistence
- **Validation**: Zod (runtime type checking)
- **HTTP Client**: Axios
- **Code Editor**: Monaco Editor
- **Icons**: Lucide React
- **Theming**: next-themes (light/dark/system)
- **Protocol Support**: Connect-ES, Protobuf-TS (gRPC)
- **Testing**: Vitest with React Testing Library
- **Desktop**: Electron 33

## Project Structure

```
restura/
├── .github/                          # GitHub configuration
│   ├── workflows/                    # CI/CD pipelines
│   │   ├── ci.yml                   # Main CI pipeline
│   │   ├── automerge.yml            # Auto-merge for PRs
│   │   └── release-drafter.yml      # Release notes automation
│   ├── config.yml                   # Release drafter config
│   └── dependabot.yml               # Dependency updates
│
├── web-client/                       # React/Next.js Frontend
│   ├── app/                         # Next.js App Router
│   ├── components/                  # React components
│   │   ├── ui/                      # shadcn/ui base components
│   │   └── [feature].tsx            # Feature components
│   ├── types/                       # TypeScript definitions
│   ├── store/                       # Zustand state stores
│   ├── lib/                         # Utility libraries
│   ├── hooks/                       # Custom React hooks
│   ├── electron/                    # Electron main process
│   └── test/                        # Test files
│
└── docs/                             # Project documentation
```

## Frontend Architecture

### Component Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       App Layout                            │
├─────────────┬───────────────────────────────┬───────────────┤
│   Sidebar   │       Main Content Area       │               │
│             ├───────────────────────────────┤               │
│ Collections │        Header Navigation       │               │
│   History   ├───────────────────────────────┤               │
│             │      Request Builder          │               │
│             │    ┌──────────────────┐       │               │
│             │    │   URL & Method   │       │               │
│             │    ├──────────────────┤       │               │
│             │    │ Tabs: Params,    │       │               │
│             │    │ Headers, Body,   │       │               │
│             │    │ Auth, Scripts    │       │               │
│             │    └──────────────────┘       │               │
│             ├───────────────────────────────┤               │
│             │      Response Viewer          │               │
│             │    ┌──────────────────┐       │               │
│             │    │ Status & Metrics │       │               │
│             │    ├──────────────────┤       │               │
│             │    │ Response Body    │       │               │
│             │    │ (Monaco Editor)  │       │               │
│             │    └──────────────────┘       │               │
└─────────────┴───────────────────────────────┴───────────────┘
```

### State Management Architecture

The application uses Zustand for state management with a distributed store pattern:

```
┌─────────────────────────────────────────────────────┐
│                    State Stores                      │
├─────────────┬─────────────┬─────────────┬───────────┤
│   Request   │ Collections │ Environment │  History  │
│    Store    │    Store    │    Store    │   Store   │
├─────────────┼─────────────┼─────────────┼───────────┤
│ - URL       │ - List      │ - Variables │ - Entries │
│ - Method    │ - Folders   │ - Active    │ - Limit   │
│ - Headers   │ - CRUD ops  │ - CRUD ops  │ - Save    │
│ - Body      │ - Persist   │ - Persist   │ - Clear   │
│ - Auth      │             │             │           │
└─────────────┴─────────────┴─────────────┴───────────┘
                      │
                      ▼
            ┌─────────────────┐
            │  localStorage   │
            │  Persistence    │
            └─────────────────┘
```

### Data Flow

```
User Input → Component → Action → Store → State Update → Re-render
                                    │
                                    ▼
                              LocalStorage
```

### Key Components

1. **RequestBuilder.tsx** - HTTP request editor with method, URL, params, headers, body
2. **ResponseViewer.tsx** - Response display with Monaco Editor syntax highlighting
3. **Sidebar.tsx** - Collections and history management
4. **AuthConfig.tsx** - Authentication configuration (Basic, Bearer, OAuth2, etc.)
5. **EnvironmentManager.tsx** - Environment variables with substitution
6. **CodeEditor.tsx** - Monaco Editor wrapper for code editing
7. **ThemeProvider.tsx** - Dark/light theme management

## Security Considerations

1. **Input Validation**: Zod schemas for runtime type checking
2. **XSS Prevention**: React's built-in escaping + CSP headers
3. **Electron Security**: Context isolation, preload scripts
4. **Script Sandboxing**: QuickJS for isolated script execution
5. **Environment Variables**: Secure storage with validation

## Performance Optimizations

1. **Turbopack**: Fast development builds with Next.js
2. **Code Splitting**: Automatic route-based code splitting
3. **Lazy Loading**: Monaco Editor loaded on demand
4. **State Persistence**: Efficient localStorage with selective updates
5. **Virtual Lists**: For large collections and history

## Testing Strategy

### Unit Testing
- Vitest for fast, modern testing
- React Testing Library for component testing
- Zod schema validation testing

### Integration Testing
- Store integration tests
- API mocking with MSW (planned)

### E2E Testing (Planned)
- Playwright for cross-browser testing
- Electron E2E with Spectron

## Deployment Architecture

### Web Deployment
- Static site generation (SSG)
- CDN deployment ready
- Security headers configured

### Desktop Deployment
- Electron Builder for cross-platform packaging
- Auto-updates support (planned)
- Code signing ready

## Future Architecture Considerations

1. **Cloud Sync**: Server-side storage for collections
2. **Team Collaboration**: Shared workspaces
3. **Plugin System**: Extensible architecture
4. **gRPC Full Support**: Complete gRPC service testing
5. **WebSocket Testing**: Real-time protocol support
6. **GraphQL Support**: GraphQL query builder

## Development Principles

1. **Type Safety**: Strict TypeScript across the entire frontend
2. **Component Isolation**: Single responsibility components
3. **State Colocation**: State close to where it's used
4. **Accessibility**: WCAG 2.1 AA compliance with Radix UI
5. **Performance First**: Optimized rendering and bundle size
6. **Security by Default**: Secure defaults, minimal permissions
