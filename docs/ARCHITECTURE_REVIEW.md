# Restura Architecture Review Report

**Date**: November 22, 2025
**Version**: 1.0
**Reviewer**: Elite Frontend Architecture Analysis

---

## Executive Summary

Restura is a well-architected multi-protocol API testing client with solid foundational patterns. The codebase demonstrates good separation of concerns, secure script execution, and comprehensive protocol support. However, several critical gaps exist when compared to mature alternatives like Postman and Hoppscotch.

**Overall Assessment**: 7/10 - Strong foundation with notable gaps in auth implementation, testing coverage, and accessibility.

---

## Table of Contents

1. [Critical Issues](#critical-issues)
2. [Project Structure Analysis](#project-structure-analysis)
3. [State Management](#state-management)
4. [Request/Response Flow](#requestresponse-flow)
5. [Protocol Support](#protocol-support)
6. [UI Components](#ui-components)
7. [Electron Integration](#electron-integration)
8. [Testing Coverage](#testing-coverage)
9. [Import/Export](#importexport)
10. [Authentication](#authentication)
11. [Script Execution](#script-execution)
12. [Code Generation](#code-generation)
13. [Security Analysis](#security-analysis)
14. [Performance Concerns](#performance-concerns)
15. [Accessibility Audit](#accessibility-audit)
16. [Feature Comparison](#feature-comparison)
17. [Recommendations](#recommendations)

---

## Critical Issues

### 1. Authentication Headers Not Applied (SEVERITY: HIGH)

**Location**: `src/lib/requestExecutor.ts`

The `AuthConfig` component allows users to configure authentication (Basic, Bearer, OAuth2, etc.), but the `requestExecutor.ts` does not generate or apply these headers to outgoing requests.

**Impact**: Users configure auth but requests are sent without authentication headers.

**Fix Required**: Implement `generateAuthHeaders()` function in requestExecutor that reads `request.auth` and generates appropriate headers.

### 2. No Request Cancellation (SEVERITY: HIGH)

**Location**: `src/hooks/useHttpRequest.ts`, `src/lib/requestExecutor.ts`

Long-running requests cannot be cancelled. The codebase doesn't use AbortController.

**Impact**: Users cannot cancel slow requests, leading to poor UX and potential memory leaks.

**Fix Required**: Add AbortController support in request execution and expose cancel function in useHttpRequest hook.

### 3. Credentials Stored in Plain Text (SEVERITY: HIGH)

**Location**: `src/store/useSettingsStore.ts`, `src/store/useEnvironmentStore.ts`

Proxy passwords, API tokens, and environment variables containing secrets are stored unencrypted in localStorage.

**Impact**: Sensitive credentials visible to any code with localStorage access.

**Fix Required**: Use encryption utilities from `src/lib/encryption.ts` for sensitive fields.

---

## Project Structure Analysis

### Directory Layout

```
src/
├── app/                    # Next.js App Router
│   ├── page.tsx           # Main entry point
│   └── layout.tsx         # Root layout
├── components/             # 31 React components
│   └── ui/                # 17 Radix UI primitives
├── hooks/                  # 3 custom hooks
│   ├── useHttpRequest.ts
│   ├── useUrlValidation.ts
│   └── useMediaQuery.ts
├── lib/                    # 13 utility modules
│   ├── requestExecutor.ts
│   ├── scriptExecutor.ts
│   ├── grpcClient.ts
│   └── ...
├── store/                  # 6 Zustand stores
│   ├── useRequestStore.ts
│   ├── useCollectionStore.ts
│   ├── useEnvironmentStore.ts
│   ├── useHistoryStore.ts
│   ├── useSettingsStore.ts
│   └── useCookieStore.ts
└── types/
    └── index.ts           # All type definitions

electron/
├── main/                   # 13 Electron modules
│   ├── main.ts            # Entry point
│   ├── preload.ts         # Context bridge
│   ├── http-handler.ts    # Native HTTP
│   ├── grpc-handler.ts    # gRPC handler
│   └── ...
└── types/
    └── index.d.ts
```

### Assessment

**Strengths**:
- Clean separation between web and Electron code
- Colocated types in single file
- UI primitives properly isolated

**Weaknesses**:
- Components are flat (not grouped by feature)
- No shared hooks between similar components
- Missing dedicated folders for constants, utils

### Recommendation

Consider feature-based organization for better scalability:
```
src/features/
├── http/
├── grpc/
├── websocket/
├── collections/
└── environments/
```

---

## State Management

### Stores Overview

| Store | Purpose | Persistence | Validation |
|-------|---------|-------------|------------|
| useRequestStore | Current request/response | Yes (partial) | Zod |
| useCollectionStore | Saved collections | Yes | Zod |
| useEnvironmentStore | Environment variables | Yes | Zod |
| useHistoryStore | Request history | Yes | Zod |
| useSettingsStore | App preferences | Yes | Zod |
| useCookieStore | Cookie management | Yes | Zod |

### Patterns Used

1. **Persist Middleware**: All stores use `zustand/middleware/persist`
2. **Zod Validation**: Schema validation in `src/lib/store-validators.ts`
3. **Selective Persistence**: `partialize` to exclude response data
4. **Version Migration**: Store version tracking for schema changes

### Gaps

1. **No Undo/Redo**: Missing temporal state management
2. **No Sync Mechanism**: Data only in localStorage
3. **No Pagination**: History loads all 100 items at once
4. **No Global Variables**: Only environment-scoped variables
5. **No Store Selectors**: Missing memoized selectors for derived state

### Code Example - Missing Selector Pattern

```typescript
// Current pattern (causes re-renders)
const collections = useCollectionStore(state => state.collections);

// Recommended pattern
const selectCollectionNames = (state) =>
  state.collections.map(c => c.name);
const collectionNames = useCollectionStore(selectCollectionNames);
```

---

## Request/Response Flow

### Flow Diagram

```
User Input → RequestBuilder
                  ↓
         Variable Resolution ({{var}})
                  ↓
         Pre-request Script (QuickJS)
                  ↓
         URL Validation (SSRF check)
                  ↓
         Cookie Attachment
                  ↓
    ┌─────────────┴─────────────┐
    │                           │
  Web (Axios)          Electron (IPC)
    │                           │
    └─────────────┬─────────────┘
                  ↓
         Response Processing
                  ↓
         Test Script Execution
                  ↓
         History Update
                  ↓
         ResponseViewer
```

### Key Files

- `src/hooks/useHttpRequest.ts` - Hook managing request lifecycle
- `src/lib/requestExecutor.ts` - Core execution logic
- `src/lib/urlValidator.ts` - URL validation with SSRF protection
- `src/store/useCookieStore.ts` - Cookie management

### Strengths

1. **SSRF Protection**: URL validator blocks private IP ranges
2. **Cookie Handling**: tough-cookie for proper cookie management
3. **Proxy Support**: Full proxy with authentication and bypass lists
4. **Redirect Handling**: Proper 301/302/303 method conversion

### Gaps

1. **No Auth Header Generation**: Auth config not used
2. **No AbortController**: Cannot cancel requests
3. **No Retry Logic**: No automatic retries on failure
4. **No Timing Breakdown**: Missing DNS/TCP/TLS timing
5. **No Request Queue**: No rate limiting or queuing

---

## Protocol Support

### HTTP/REST

**Status**: Complete
**Location**: `src/components/RequestBuilder.tsx`

**Features**:
- All methods: GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD
- Body types: JSON, XML, form-data, x-www-form-urlencoded, binary, text, GraphQL
- Headers and query parameters
- File uploads

**Gaps**:
- No multipart/mixed support
- No streaming request bodies

### GraphQL

**Status**: Partial
**Location**: `src/components/RequestBuilder.tsx` (body type)

**Features**:
- GraphQL body type with variables

**Gaps**:
- No dedicated GraphQL editor
- No schema introspection
- No query/mutation syntax highlighting
- No variable extraction
- No autocomplete

### gRPC

**Status**: Comprehensive
**Location**: `src/components/GrpcRequestBuilder.tsx`, `src/lib/grpcClient.ts`

**Features**:
- All streaming types (unary, server, client, bidirectional)
- Server reflection
- Proto file parsing
- Metadata support
- Message editor with validation

**Gaps**:
- Must provide proto file (no reflection-only mode)
- No proto registry
- No saved method history

### WebSocket

**Status**: Basic
**Location**: `src/components/WebSocketClient.tsx`

**Features**:
- Connect/disconnect
- Send/receive messages
- Message history
- Protocols support

**Gaps**:
- Headers not actually sent (browser limitation - noted in code)
- No binary message support
- No message filtering/search
- Connection lost on component unmount
- No auto-reconnect

---

## UI Components

### Component Inventory

**Main Components** (31 total):
- RequestBuilder.tsx
- ResponseViewer.tsx
- Sidebar.tsx
- CollectionRunner.tsx
- EnvironmentManager.tsx
- AuthConfig.tsx
- CodeGeneratorDialog.tsx
- GrpcRequestBuilder.tsx
- WebSocketClient.tsx
- CommandPalette.tsx
- SettingsDialog.tsx
- ...and 20 more

**UI Primitives** (17 total):
- Button, Input, Dialog
- Select, Tabs, Dropdown
- Tooltip, Accordion
- ...and 9 more

### Patterns

1. **Radix UI Primitives**: All base components built on Radix
2. **Tailwind CSS 4**: Utility-first styling
3. **shadcn/ui Pattern**: Composable, customizable components
4. **Framer Motion**: Animation library integrated

### Issues

1. **Large Components**: Some components exceed 500 lines
2. **Duplicated Logic**: Similar patterns in RequestBuilder and GrpcRequestBuilder
3. **Missing Error Boundaries**: No component-level error handling
4. **No Skeleton Loading**: Missing loading states

### Recommendations

1. Extract shared logic into custom hooks
2. Break large components into smaller pieces
3. Add error boundaries around critical sections
4. Implement skeleton loading for async content

---

## Electron Integration

### IPC Architecture

```
Renderer Process              Main Process
     │                              │
     │   electronAPI.httpRequest    │
     ├─────────────────────────────→│ http-handler.ts
     │                              │
     │   electronAPI.grpcRequest    │
     ├─────────────────────────────→│ grpc-handler.ts
     │                              │
     │   electronAPI.selectFile     │
     ├─────────────────────────────→│ file-operations.ts
     │                              │
```

### Security Measures

**Location**: `electron/main/preload.ts`, `electron/main/ipc-validators.ts`

1. **Context Bridge**: Safe exposure via contextBridge
2. **Input Validation**: Zod schemas for all IPC inputs
3. **Channel Whitelisting**: Only allowed events can be subscribed
4. **SSL Configurable**: Can disable verification for testing

### Handlers

| File | Purpose |
|------|---------|
| main.ts | App lifecycle, orchestration |
| window-manager.ts | Window creation |
| http-handler.ts | Native HTTP with proxy |
| grpc-handler.ts | gRPC execution |
| file-operations.ts | File system access |
| auto-updater.ts | App updates |
| notifications.ts | Native notifications |

### Gaps

1. **No CSP**: Content Security Policy not configured
2. **Plain Text Proxy Creds**: Not encrypted
3. **No Certificate Pinning**: Can't pin specific certs
4. **No Isolated Storage**: All data in same localStorage

---

## Testing Coverage

### Current Tests

| Location | Tests | Coverage |
|----------|-------|----------|
| src/lib/__tests__/ | 6 files | Partial |
| src/store/__tests__/ | 3 files | Good |
| components/ | 0 files | None |
| electron/ | 0 files | None |
| e2e/ | 0 files | None |

### Test Files Detail

```
src/lib/__tests__/
├── encryption.test.ts        # Encryption utilities
├── grpcClient.test.ts        # gRPC client
├── grpcReflection.test.ts    # gRPC reflection
├── urlValidator.test.ts      # URL validation
├── store-validators.test.ts  # Zod schemas
└── critical-fixes.test.ts    # Critical bug tests

src/store/__tests__/
├── useCollectionStore.test.ts
├── useEnvironmentStore.test.ts
└── useRequestStore.test.ts
```

### Missing Test Coverage

**Critical - Not Tested**:
- requestExecutor.ts
- scriptExecutor.ts
- codeGenerators.ts
- importers.ts / exporters.ts
- All 31 components
- All Electron IPC handlers

### Testing Recommendations

1. **Unit Tests**: Add tests for all lib modules
2. **Component Tests**: Use React Testing Library
3. **Integration Tests**: Test store interactions
4. **E2E Tests**: Add Playwright for critical flows
5. **IPC Tests**: Mock Electron for handler tests

---

## Import/Export

### Supported Formats

| Format | Import | Export |
|--------|--------|--------|
| Postman v2.1 | Yes | Yes |
| Insomnia v4 | Yes | Yes |
| OpenAPI | No | No |
| HAR | No | No |
| cURL | No | No |

### Features

**Location**: `src/lib/importers.ts`, `src/lib/exporters.ts`

- Auth type conversion
- Script migration
- Folder structure preservation
- Variable support

### Gaps

1. **No cURL Import**: Very common workflow
2. **No OpenAPI/Swagger**: Standard API spec
3. **No HAR Import**: Browser network export
4. **No Environment Export**: Only collections
5. **No gRPC Export**: Only HTTP requests

### cURL Import Priority

Most requested feature. Should support:
- All HTTP methods
- Headers (-H)
- Data (-d, --data-raw)
- Form data (-F)
- Basic auth (-u)
- Cookies (-b)

---

## Authentication

### Supported Types

**Location**: `src/components/AuthConfig.tsx`, `src/types/index.ts:63-81`

| Type | Status | Notes |
|------|--------|-------|
| None | Working | - |
| Basic | UI Only | Headers not generated |
| Bearer | UI Only | Headers not generated |
| API Key | UI Only | Headers not generated |
| OAuth 2.0 | Partial | Token only, no flows |
| Digest | UI Only | Headers not generated |
| AWS Sig v4 | UI Only | Headers not generated |

### Critical Issue

The auth configuration exists in UI but is NOT APPLIED to requests. `requestExecutor.ts` doesn't read the `request.auth` field.

### Missing Auth Features

1. **OAuth 2.0 Flows**: No authorization code, PKCE, etc.
2. **NTLM/Kerberos**: Enterprise auth
3. **Client Certificates**: mTLS support
4. **Credential Encryption**: Plain text storage
5. **Auth Inheritance**: Collection → Folder → Request

### Fix Implementation

```typescript
// In requestExecutor.ts
function generateAuthHeaders(auth: AuthConfig): Record<string, string> {
  switch (auth.type) {
    case 'basic':
      const credentials = btoa(`${auth.username}:${auth.password}`);
      return { 'Authorization': `Basic ${credentials}` };
    case 'bearer':
      return { 'Authorization': `Bearer ${auth.token}` };
    case 'apikey':
      if (auth.addTo === 'header') {
        return { [auth.key]: auth.value };
      }
      return {};
    // ... other types
  }
}
```

---

## Script Execution

### Security Model

**Location**: `src/lib/scriptExecutor.ts`

**Excellent Security**:
- QuickJS sandbox (not Node.js eval)
- 5-second timeout
- 10MB memory limit
- Dangerous pattern blocking
- Strict mode enforcement

### Blocked Patterns

```javascript
const dangerousPatterns = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\b__proto__\b/,
  /\bconstructor\s*\[/,
  /\bprocess\b/,
  /\brequire\s*\(/,
  /\bimport\s*\(/,
];
```

### Available API

```javascript
// Variables
pm.variables.get(key)
pm.variables.set(key, value)
pm.globals.get(key)
pm.globals.set(key, value)

// Testing
pm.test(name, fn)
pm.expect(value)

// Response (test scripts only)
pm.response.to.have.status(200)
pm.response.to.have.header(name)
pm.response.to.have.body(text)

// Console
console.log()
console.error()
console.warn()
console.info()
```

### Missing API

1. **pm.sendRequest()**: Request chaining
2. **pm.cookies**: Cookie access
3. **pm.environment**: Environment manipulation
4. **Crypto utilities**: btoa, atob, CryptoJS
5. **setTimeout/setInterval**: Async operations
6. **require()**: Library imports

---

## Code Generation

### Supported Languages

**Location**: `src/lib/codeGenerators.ts`

1. **cURL** - Command line
2. **Python** - requests library
3. **JavaScript** - fetch API
4. **Node.js** - axios library
5. **Go** - net/http
6. **Ruby** - net/http
7. **PHP** - cURL

### Features

- Proxy configuration
- SSL verification options
- Timeout settings
- Headers and body

### Missing Languages

- Java / Kotlin
- C# / .NET
- Swift / Objective-C
- Rust
- PowerShell

### Missing Features

1. **Auth not included**: Auth headers not generated in code
2. **No query params**: Not properly encoded
3. **No file uploads**: Form-data with files

---

## Security Analysis

### Strengths

1. **Script Sandbox**: QuickJS isolation
2. **SSRF Protection**: URL validator blocks private IPs
3. **Input Validation**: Zod for IPC
4. **Context Bridge**: Safe Electron exposure

### Vulnerabilities

| Issue | Severity | Location |
|-------|----------|----------|
| Plain text credentials | High | All stores |
| No CSP | Medium | Electron |
| XSS in response viewer | Medium | ResponseViewer |
| No cert pinning | Low | http-handler |

### Recommendations

1. Encrypt all credentials at rest
2. Implement CSP headers
3. Sanitize response HTML preview
4. Add certificate pinning option

---

## Performance Concerns

### Current Issues

1. **Large Collection Loading**: No virtualization
2. **History Without Pagination**: 100 items loaded
3. **No Code Splitting**: Lazy load CodeEditor
4. **Proto Re-parsing**: Parse on every request
5. **No Request Caching**: Always fresh requests

### Recommendations

1. **Virtual Lists**: Use react-virtual for collections
2. **Paginate History**: Load 20 at a time
3. **Lazy Load**: Dynamic import for heavy components
4. **Cache Proto**: Memoize parsed proto files
5. **Response Caching**: Optional request caching

### Code Example - Lazy Loading

```typescript
const CodeEditor = lazy(() => import('./CodeEditor'));

<Suspense fallback={<Skeleton />}>
  <CodeEditor value={code} />
</Suspense>
```

---

## Accessibility Audit

### Current State

Only **48 ARIA attributes** found across **11 components**.

### Components with Accessibility

| Component | Attributes | Status |
|-----------|------------|--------|
| AriaLiveAnnouncer | 6 | Good |
| CommandPalette | 12 | Good |
| RequestLine | 7 | Partial |
| Sidebar | 5 | Partial |
| Others | 18 | Poor |

### Components Lacking Accessibility

- AuthConfig.tsx
- CollectionRunner.tsx
- SettingsDialog.tsx
- EnvironmentManager.tsx
- ResponseViewer.tsx
- Most form components

### Issues

1. **No Focus Management**: Dialogs don't trap focus
2. **Missing Labels**: Form inputs without labels
3. **No Keyboard Navigation**: Lists not navigable
4. **No Skip Links**: Can't skip to main content
5. **No Announcements**: Async operations not announced

### Required Fixes

```typescript
// Focus trap in dialogs
<Dialog>
  <FocusTrap>
    <DialogContent>...</DialogContent>
  </FocusTrap>
</Dialog>

// Keyboard navigation in lists
<ul role="listbox" aria-label="Collections">
  {items.map(item => (
    <li
      role="option"
      tabIndex={0}
      onKeyDown={handleKeyNav}
    >
      {item.name}
    </li>
  ))}
</ul>

// Announce async operations
<AriaLiveAnnouncer>
  {isLoading ? 'Sending request...' : `Response received: ${status}`}
</AriaLiveAnnouncer>
```

---

## Feature Comparison

### vs Postman

| Feature | Restura | Postman |
|---------|---------|---------|
| HTTP/REST | Full | Full |
| GraphQL | Basic | Full |
| gRPC | Full | Partial |
| WebSocket | Basic | Full |
| Import/Export | Partial | Full |
| OAuth Flows | No | Full |
| Mock Server | No | Yes |
| Monitoring | No | Yes |
| Collaboration | No | Yes |
| Documentation | No | Yes |

### vs Hoppscotch

| Feature | Restura | Hoppscotch |
|---------|---------|------------|
| Desktop App | Yes | Yes |
| Real-time | Basic | Full |
| Collections | Yes | Yes |
| Environments | Yes | Yes |
| Pre-request Scripts | Yes | Yes |
| Test Scripts | Yes | Yes |
| GraphQL | Basic | Full |
| SSE | No | Yes |
| MQTT | No | Yes |
| Socket.IO | No | Yes |

---

## Recommendations

### Phase 1: Critical Fixes (1-2 weeks)

1. **Fix Auth Header Generation**
   - Implement `generateAuthHeaders()` in requestExecutor
   - Apply headers before request execution
   - Test all auth types

2. **Add Request Cancellation**
   - Add AbortController to useHttpRequest
   - Expose cancel function
   - Handle abort errors gracefully

3. **Encrypt Credentials**
   - Use existing encryption.ts
   - Encrypt proxy passwords
   - Encrypt API tokens
   - Encrypt sensitive env vars

### Phase 2: Core Features (2-4 weeks)

1. **cURL Import**
   - Parse cURL command syntax
   - Extract method, URL, headers, body
   - Support auth flags

2. **OpenAPI Import**
   - Parse OpenAPI 3.x spec
   - Generate requests from paths
   - Import schemas for validation

3. **Full OAuth 2.0**
   - Authorization Code flow
   - PKCE support
   - Token refresh
   - Multiple grant types

4. **Collection Variables**
   - Add variables to collections
   - Scope: Global → Collection → Folder → Request
   - Variable precedence

### Phase 3: Quality (2-3 weeks)

1. **Component Tests**
   - Test all 31 components
   - User interaction tests
   - Accessibility tests

2. **E2E Tests**
   - Critical user flows
   - Cross-browser testing
   - Electron app testing

3. **Accessibility**
   - Focus management
   - Keyboard navigation
   - Screen reader support
   - WCAG 2.1 AA compliance

4. **Response Timing**
   - DNS lookup time
   - TCP connection
   - TLS handshake
   - Time to first byte
   - Content download

### Phase 4: Advanced (4+ weeks)

1. **Request Chaining**
   - Implement pm.sendRequest()
   - Async script support
   - Response data extraction

2. **Mock Server**
   - Define mock responses
   - URL matching rules
   - Dynamic responses

3. **Test Reports**
   - HTML report generation
   - JUnit XML export
   - Test history

4. **GraphQL Introspection**
   - Fetch schema
   - Autocomplete
   - Query validation

---

## Conclusion

Restura has a solid architectural foundation with excellent security patterns in script execution and proper state management with Zustand. The gRPC support is particularly well-implemented.

**Immediate priorities**:
1. Fix auth header generation (breaking issue)
2. Add request cancellation (UX critical)
3. Encrypt credentials (security)

**Competitive gaps**:
- cURL/OpenAPI import
- Full OAuth 2.0 flows
- GraphQL introspection
- Accessibility

With these improvements, Restura can become a strong competitor to Postman and Hoppscotch, particularly for teams needing gRPC support and a desktop-first experience.

---

## Appendix

### File Reference

| Area | Key Files |
|------|-----------|
| Types | `src/types/index.ts` |
| Request Execution | `src/lib/requestExecutor.ts` |
| Script Sandbox | `src/lib/scriptExecutor.ts` |
| Auth Config | `src/components/AuthConfig.tsx` |
| Code Generation | `src/lib/codeGenerators.ts` |
| Import/Export | `src/lib/importers.ts`, `src/lib/exporters.ts` |
| Stores | `src/store/*.ts` |
| Store Validation | `src/lib/store-validators.ts` |
| URL Validation | `src/lib/urlValidator.ts` |
| Electron IPC | `electron/main/preload.ts`, `electron/main/http-handler.ts` |
| gRPC | `src/lib/grpcClient.ts`, `src/components/GrpcRequestBuilder.tsx` |
| WebSocket | `src/components/WebSocketClient.tsx` |

### Test Commands

```bash
npm run test:run           # Run all tests
npm run test:coverage      # Coverage report
npm run test:ui            # Visual test runner
npm run validate           # Full CI pipeline
```
