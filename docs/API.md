# Restura - API Reference

This document provides a comprehensive reference for Restura's internal APIs, including state stores, utilities, and type definitions.

## Table of Contents

- [State Stores](#state-stores)
- [Type Definitions](#type-definitions)
- [Utility Functions](#utility-functions)
- [Custom Hooks](#custom-hooks)
- [Validation Schemas](#validation-schemas)

## State Stores

Restura uses Zustand for state management with multiple specialized stores.

### useRequestStore

Manages the current request state.

```typescript
interface RequestStore {
  // State
  url: string;
  method: HttpMethod;
  params: QueryParam[];
  headers: Header[];
  body: string;
  bodyType: BodyType;
  auth: AuthConfig;
  preRequestScript: string;
  testScript: string;

  // Actions
  setUrl: (url: string) => void;
  setMethod: (method: HttpMethod) => void;
  setParams: (params: QueryParam[]) => void;
  setHeaders: (headers: Header[]) => void;
  setBody: (body: string) => void;
  setBodyType: (bodyType: BodyType) => void;
  setAuth: (auth: AuthConfig) => void;
  setPreRequestScript: (script: string) => void;
  setTestScript: (script: string) => void;
  loadRequest: (request: SavedRequest) => void;
  reset: () => void;
}
```

**Usage:**

```typescript
import { useRequestStore } from '@/store/useRequestStore';

// In component
const url = useRequestStore((state) => state.url);
const setUrl = useRequestStore((state) => state.setUrl);

// Update URL
setUrl('https://api.example.com/users');

// Load saved request
const loadRequest = useRequestStore((state) => state.loadRequest);
loadRequest(savedRequest);
```

### useCollectionStore

Manages collections and folders.

```typescript
interface CollectionStore {
  // State
  collections: Collection[];

  // Actions
  addCollection: (collection: Collection) => void;
  updateCollection: (id: string, updates: Partial<Collection>) => void;
  deleteCollection: (id: string) => void;
  addFolder: (collectionId: string, folder: Folder) => void;
  updateFolder: (collectionId: string, folderId: string, updates: Partial<Folder>) => void;
  deleteFolder: (collectionId: string, folderId: string) => void;
  addRequest: (collectionId: string, folderId: string | null, request: SavedRequest) => void;
  updateRequest: (collectionId: string, folderId: string | null, requestId: string, updates: Partial<SavedRequest>) => void;
  deleteRequest: (collectionId: string, folderId: string | null, requestId: string) => void;
  importCollection: (data: unknown, format: ImportFormat) => void;
  exportCollection: (collectionId: string, format: ExportFormat) => string;
}
```

**Usage:**

```typescript
import { useCollectionStore } from '@/store/useCollectionStore';

// Add collection
const addCollection = useCollectionStore((state) => state.addCollection);
addCollection({
  id: 'col-1',
  name: 'My API',
  folders: [],
  requests: [],
  createdAt: new Date().toISOString(),
});

// Add request to collection
const addRequest = useCollectionStore((state) => state.addRequest);
addRequest('col-1', null, {
  id: 'req-1',
  name: 'Get Users',
  url: 'https://api.example.com/users',
  method: 'GET',
  // ...
});
```

### useEnvironmentStore

Manages environment variables.

```typescript
interface EnvironmentStore {
  // State
  environments: Environment[];
  activeEnvironmentId: string | null;

  // Actions
  addEnvironment: (env: Environment) => void;
  updateEnvironment: (id: string, updates: Partial<Environment>) => void;
  deleteEnvironment: (id: string) => void;
  setActiveEnvironment: (id: string | null) => void;
  addVariable: (envId: string, variable: EnvironmentVariable) => void;
  updateVariable: (envId: string, varId: string, updates: Partial<EnvironmentVariable>) => void;
  deleteVariable: (envId: string, varId: string) => void;
  resolveVariables: (text: string) => string;
}
```

**Usage:**

```typescript
import { useEnvironmentStore } from '@/store/useEnvironmentStore';

// Create environment
const addEnvironment = useEnvironmentStore((state) => state.addEnvironment);
addEnvironment({
  id: 'env-1',
  name: 'Production',
  variables: [
    { id: 'var-1', key: 'BASE_URL', value: 'https://api.example.com', enabled: true },
    { id: 'var-2', key: 'API_KEY', value: 'secret123', enabled: true },
  ],
});

// Resolve variables in text
const resolveVariables = useEnvironmentStore((state) => state.resolveVariables);
const url = resolveVariables('{{BASE_URL}}/users?key={{API_KEY}}');
// Result: 'https://api.example.com/users?key=secret123'
```

### useHistoryStore

Manages request history.

```typescript
interface HistoryStore {
  // State
  entries: HistoryEntry[];
  maxEntries: number;

  // Actions
  addEntry: (entry: HistoryEntry) => void;
  removeEntry: (id: string) => void;
  clearHistory: () => void;
  toggleFavorite: (id: string) => void;
  setMaxEntries: (max: number) => void;
}
```

**Usage:**

```typescript
import { useHistoryStore } from '@/store/useHistoryStore';

// Add history entry
const addEntry = useHistoryStore((state) => state.addEntry);
addEntry({
  id: 'hist-1',
  request: { /* request data */ },
  response: { /* response data */ },
  timestamp: new Date().toISOString(),
  isFavorite: false,
});

// Get favorites
const entries = useHistoryStore((state) => state.entries);
const favorites = entries.filter((e) => e.isFavorite);
```

### useSettingsStore

Manages application settings.

```typescript
interface SettingsStore {
  // State
  theme: 'light' | 'dark' | 'system';
  fontSize: number;
  wordWrap: boolean;
  autoSave: boolean;
  timeout: number;
  followRedirects: boolean;
  validateSSL: boolean;
  proxy: ProxyConfig | null;

  // Actions
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setFontSize: (size: number) => void;
  setWordWrap: (wrap: boolean) => void;
  setAutoSave: (save: boolean) => void;
  setTimeout: (timeout: number) => void;
  setFollowRedirects: (follow: boolean) => void;
  setValidateSSL: (validate: boolean) => void;
  setProxy: (proxy: ProxyConfig | null) => void;
}
```

## Type Definitions

### Core Types

```typescript
// HTTP Methods
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';

// Body Types
type BodyType = 'none' | 'json' | 'text' | 'xml' | 'form-data' | 'x-www-form-urlencoded' | 'binary';

// Query Parameter
interface QueryParam {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

// Header
interface Header {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

// Form Data Field
interface FormDataField {
  id: string;
  key: string;
  value: string;
  type: 'text' | 'file';
  enabled: boolean;
}
```

### Authentication Types

```typescript
type AuthType =
  | 'none'
  | 'basic'
  | 'bearer'
  | 'api-key'
  | 'oauth2'
  | 'digest'
  | 'aws-signature';

interface AuthConfig {
  type: AuthType;
  // Basic Auth
  username?: string;
  password?: string;
  // Bearer Token
  token?: string;
  // API Key
  apiKey?: string;
  apiKeyName?: string;
  apiKeyLocation?: 'header' | 'query';
  // OAuth2
  oauth2?: {
    grantType: 'authorization_code' | 'client_credentials' | 'password' | 'implicit';
    accessTokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    scope?: string;
    state?: string;
  };
  // Digest Auth
  digest?: {
    username: string;
    password: string;
    realm?: string;
    nonce?: string;
  };
  // AWS Signature
  aws?: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    service: string;
  };
}
```

### Request/Response Types

```typescript
interface SavedRequest {
  id: string;
  name: string;
  url: string;
  method: HttpMethod;
  params: QueryParam[];
  headers: Header[];
  body: string;
  bodyType: BodyType;
  auth: AuthConfig;
  preRequestScript?: string;
  testScript?: string;
  createdAt: string;
  updatedAt: string;
}

interface Response {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  contentType: string;
  size: number;
  time: number;
}

interface HistoryEntry {
  id: string;
  request: SavedRequest;
  response: Response;
  timestamp: string;
  isFavorite: boolean;
}
```

### Collection Types

```typescript
interface Collection {
  id: string;
  name: string;
  description?: string;
  folders: Folder[];
  requests: SavedRequest[];
  createdAt: string;
  updatedAt?: string;
}

interface Folder {
  id: string;
  name: string;
  requests: SavedRequest[];
}

interface Environment {
  id: string;
  name: string;
  variables: EnvironmentVariable[];
}

interface EnvironmentVariable {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}
```

### Proxy Types

```typescript
interface ProxyConfig {
  enabled: boolean;
  host: string;
  port: number;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  auth?: {
    username: string;
    password: string;
  };
  bypass?: string[];
}
```

## Utility Functions

### URL Utilities

```typescript
import { buildUrl, parseUrl, resolveVariables } from '@/lib/utils';

// Build URL with query parameters
const url = buildUrl('https://api.example.com/users', [
  { id: '1', key: 'page', value: '1', enabled: true },
  { id: '2', key: 'limit', value: '10', enabled: true },
]);
// Result: 'https://api.example.com/users?page=1&limit=10'

// Parse URL into components
const parsed = parseUrl('https://api.example.com/users?page=1');
// Result: { baseUrl: '...', params: [...] }

// Resolve environment variables
const resolved = resolveVariables('{{BASE_URL}}/users', variables);
```

### Code Generators

```typescript
import { generateCode } from '@/lib/codeGenerators';

// Generate cURL command
const curl = generateCode(request, 'curl');
// Result: 'curl -X GET "https://api.example.com/users" -H "Content-Type: application/json"'

// Generate JavaScript/Fetch code
const fetch = generateCode(request, 'javascript-fetch');

// Generate Python/Requests code
const python = generateCode(request, 'python-requests');

// Supported languages:
// - curl
// - javascript-fetch
// - javascript-axios
// - python-requests
// - go
// - rust
// - php
// - ruby
```

### Import/Export

```typescript
import { importCollection, exportCollection } from '@/lib/importers';

// Import Postman collection
const collection = importCollection(postmanJson, 'postman');

// Import Insomnia collection
const collection = importCollection(insomniaJson, 'insomnia');

// Export to Postman format
const postmanJson = exportCollection(collection, 'postman');

// Export to Insomnia format
const insomniaJson = exportCollection(collection, 'insomnia');
```

### Class Name Utility

```typescript
import { cn } from '@/lib/utils';

// Merge Tailwind classes
const className = cn(
  'base-class',
  isActive && 'active-class',
  variant === 'primary' && 'bg-blue-500'
);
```

## Custom Hooks

### useHttpRequest

Hook for executing HTTP requests.

```typescript
import { useHttpRequest } from '@/hooks/useHttpRequest';

function RequestComponent() {
  const { execute, response, loading, error } = useHttpRequest();

  const handleSend = async () => {
    await execute({
      url: 'https://api.example.com/data',
      method: 'GET',
      headers: [{ id: '1', key: 'Accept', value: 'application/json', enabled: true }],
    });
  };

  return (
    <div>
      <button onClick={handleSend} disabled={loading}>
        {loading ? 'Sending...' : 'Send'}
      </button>
      {error && <div>Error: {error.message}</div>}
      {response && <div>Status: {response.status}</div>}
    </div>
  );
}
```

### useElectronMenu

Hook for Electron menu integration.

```typescript
import { useElectronMenu } from '@/hooks/useElectronMenu';

function App() {
  useElectronMenu({
    onNew: () => resetRequest(),
    onOpen: (data) => loadRequest(data),
    onSave: () => saveRequest(),
    onImport: (data) => importCollection(data),
    onExport: () => exportCollection(),
  });

  return <AppContent />;
}
```

### useDebounce

Hook for debouncing values.

```typescript
import { useDebounce } from '@/hooks/useDebounce';

function SearchComponent() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);

  useEffect(() => {
    // Execute search with debounced value
    performSearch(debouncedSearch);
  }, [debouncedSearch]);

  return <input value={search} onChange={(e) => setSearch(e.target.value)} />;
}
```

## Validation Schemas

DJ uses Zod for runtime type validation.

### Request Validation

```typescript
import { RequestSchema, validateRequest } from '@/lib/validations';

const result = validateRequest({
  url: 'https://api.example.com',
  method: 'GET',
  headers: [],
  body: '',
});

if (result.success) {
  // Valid request
  const request = result.data;
} else {
  // Invalid request
  console.error(result.error);
}
```

### URL Validation

```typescript
import { z } from 'zod';

const UrlSchema = z.string().url().or(z.string().regex(/^\{\{.*\}\}$/));

// Valid URLs:
// - 'https://api.example.com'
// - '{{BASE_URL}}/users'
```

### Environment Validation

```typescript
import { EnvironmentSchema } from '@/lib/validations';

const result = EnvironmentSchema.safeParse({
  id: 'env-1',
  name: 'Production',
  variables: [
    { id: 'var-1', key: 'API_KEY', value: 'secret', enabled: true },
  ],
});
```

### Store Validation

```typescript
import { validateStoreData } from '@/lib/store-validators';

// Validate persisted store data on load
const validatedData = validateStoreData(rawData, 'collections');
```

---

For more information, refer to the source code in the respective directories:
- Stores: `web-client/store/`
- Types: `web-client/types/`
- Utilities: `web-client/lib/`
- Hooks: `web-client/hooks/`
