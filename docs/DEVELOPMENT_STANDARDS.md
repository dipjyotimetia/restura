# Development Standards

This document outlines the development standards and best practices for the Restura project.

## Table of Contents

- [Code Quality](#code-quality)
- [TypeScript Standards](#typescript-standards)
- [React Best Practices](#react-best-practices)
- [State Management](#state-management)
- [Styling Guidelines](#styling-guidelines)
- [Testing Standards](#testing-standards)
- [Go Standards](#go-standards)
- [Security Standards](#security-standards)
- [Performance Guidelines](#performance-guidelines)
- [Documentation Standards](#documentation-standards)

## Code Quality

### General Principles

1. **DRY (Don't Repeat Yourself)**: Extract common logic into reusable functions
2. **KISS (Keep It Simple, Stupid)**: Prefer simple solutions over complex ones
3. **YAGNI (You Aren't Gonna Need It)**: Don't add functionality until needed
4. **Single Responsibility**: Each function/component should do one thing well
5. **Clean Code**: Write self-documenting code with clear naming

### Code Review Checklist

- [ ] Code is readable and self-explanatory
- [ ] No code duplication
- [ ] Proper error handling
- [ ] No security vulnerabilities
- [ ] Performance considerations addressed
- [ ] Tests included for new functionality
- [ ] Documentation updated
- [ ] No console.log or debug statements
- [ ] No commented-out code

## TypeScript Standards

### Configuration

We use strict TypeScript configuration:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

### Type Best Practices

```typescript
// 1. Always define explicit return types for functions
function calculateTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}

// 2. Use interfaces for object shapes
interface RequestConfig {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

// 3. Use type for unions and primitives
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
type ResponseStatus = 'pending' | 'success' | 'error';

// 4. Avoid 'any', use 'unknown' for uncertain types
function parseResponse(data: unknown): ParsedResponse {
  if (isValidResponse(data)) {
    return data as ParsedResponse;
  }
  throw new Error('Invalid response');
}

// 5. Use generics for reusable code
function createStore<T>(initialState: T): Store<T> {
  let state = initialState;
  return {
    getState: () => state,
    setState: (newState: T) => { state = newState; }
  };
}

// 6. Use const assertions for literal types
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
type Method = typeof HTTP_METHODS[number];

// 7. Use discriminated unions for complex state
type RequestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: Response }
  | { status: 'error'; error: Error };
```

### Naming Conventions

- **Variables/Functions**: camelCase
- **Types/Interfaces**: PascalCase
- **Constants**: UPPER_SNAKE_CASE or camelCase
- **Files**: PascalCase for components, camelCase for utilities
- **Folders**: kebab-case

```typescript
// Good
const maxRetries = 3;
const API_BASE_URL = 'https://api.example.com';

interface UserProfile {
  id: string;
  displayName: string;
}

function fetchUserProfile(userId: string): Promise<UserProfile> {
  // implementation
}

// Component file: RequestBuilder.tsx
// Utility file: formatResponse.ts
// Hook file: useHttpRequest.ts
```

## React Best Practices

### Component Structure

```typescript
// 1. Props interface first
interface RequestBuilderProps {
  onSubmit: (request: Request) => void;
  initialRequest?: Request;
  disabled?: boolean;
}

// 2. Component function
export function RequestBuilder({
  onSubmit,
  initialRequest,
  disabled = false,
}: RequestBuilderProps) {
  // 3. Hooks at the top
  const [url, setUrl] = useState(initialRequest?.url ?? '');
  const [method, setMethod] = useState<HttpMethod>(initialRequest?.method ?? 'GET');

  // 4. Derived state
  const isValid = useMemo(() => validateUrl(url), [url]);

  // 5. Event handlers
  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    if (isValid) {
      onSubmit({ url, method });
    }
  }, [url, method, isValid, onSubmit]);

  // 6. Effects (if needed)
  useEffect(() => {
    // Side effects
  }, [dependencies]);

  // 7. Early returns for conditional rendering
  if (disabled) {
    return <DisabledView />;
  }

  // 8. Main render
  return (
    <form onSubmit={handleSubmit}>
      {/* JSX */}
    </form>
  );
}
```

### Component Best Practices

```typescript
// 1. Use composition over inheritance
function Card({ children, className }: CardProps) {
  return (
    <div className={cn('rounded-lg border p-4', className)}>
      {children}
    </div>
  );
}

// 2. Forward refs when needed
const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn('border rounded px-3 py-2', className)}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

// 3. Use controlled components
function ControlledInput({ value, onChange }: ControlledInputProps) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// 4. Memoize expensive computations
const sortedItems = useMemo(
  () => items.sort((a, b) => a.name.localeCompare(b.name)),
  [items]
);

// 5. Memoize callbacks passed to children
const handleClick = useCallback(() => {
  // handler logic
}, [dependencies]);

// 6. Use error boundaries
<ErrorBoundary fallback={<ErrorView />}>
  <ComplexComponent />
</ErrorBoundary>
```

### Hooks Guidelines

```typescript
// 1. Custom hooks for reusable logic
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// 2. Cleanup in useEffect
useEffect(() => {
  const controller = new AbortController();

  fetchData(controller.signal).then(setData);

  return () => controller.abort();
}, []);

// 3. Avoid over-using useEffect
// Bad: Deriving state in effect
useEffect(() => {
  setFullName(`${firstName} ${lastName}`);
}, [firstName, lastName]);

// Good: Derive directly
const fullName = `${firstName} ${lastName}`;
```

## State Management

### Zustand Store Structure

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// 1. Define state interface
interface RequestState {
  url: string;
  method: HttpMethod;
  headers: Header[];
  body: string;
}

// 2. Define actions interface
interface RequestActions {
  setUrl: (url: string) => void;
  setMethod: (method: HttpMethod) => void;
  addHeader: (header: Header) => void;
  removeHeader: (id: string) => void;
  reset: () => void;
}

// 3. Combine into store type
type RequestStore = RequestState & RequestActions;

// 4. Create initial state
const initialState: RequestState = {
  url: '',
  method: 'GET',
  headers: [],
  body: '',
};

// 5. Create store with persistence
export const useRequestStore = create<RequestStore>()(
  persist(
    (set) => ({
      ...initialState,

      setUrl: (url) => set({ url }),

      setMethod: (method) => set({ method }),

      addHeader: (header) =>
        set((state) => ({
          headers: [...state.headers, header],
        })),

      removeHeader: (id) =>
        set((state) => ({
          headers: state.headers.filter((h) => h.id !== id),
        })),

      reset: () => set(initialState),
    }),
    {
      name: 'request-storage',
      version: 1,
    }
  )
);

// 6. Use selectors for performance
function RequestUrl() {
  // Good: Only subscribes to url changes
  const url = useRequestStore((state) => state.url);
  const setUrl = useRequestStore((state) => state.setUrl);

  return <input value={url} onChange={(e) => setUrl(e.target.value)} />;
}

// Bad: Subscribes to all changes
function BadComponent() {
  const store = useRequestStore();
  return <input value={store.url} />;
}
```

### State Best Practices

1. **Keep state minimal**: Only store what you need
2. **Normalize complex data**: Use flat structures with IDs
3. **Validate on write**: Use Zod schemas for validation
4. **Handle loading/error states**: Use discriminated unions
5. **Persist carefully**: Only persist non-sensitive data

## Styling Guidelines

### Tailwind CSS Standards

```tsx
// 1. Use utility classes
<div className="flex items-center gap-4 p-6 bg-white rounded-lg shadow">

// 2. Responsive design (mobile-first)
<div className="flex flex-col md:flex-row lg:gap-8">

// 3. Dark mode support
<div className="bg-white dark:bg-zinc-900 text-black dark:text-white">

// 4. Group related utilities
<button className={cn(
  // Base styles
  'inline-flex items-center justify-center rounded-md',
  // Size
  'h-10 px-4 py-2',
  // Typography
  'text-sm font-medium',
  // Colors
  'bg-primary text-primary-foreground',
  // States
  'hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2',
  // Disabled
  'disabled:pointer-events-none disabled:opacity-50',
)}>

// 5. Use cn() for conditional classes
<div className={cn(
  'base-class',
  isActive && 'active-class',
  variant === 'primary' && 'primary-variant',
)}>

// 6. Extract repeated patterns into components
function Badge({ variant = 'default', children }: BadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
      variants[variant],
    )}>
      {children}
    </span>
  );
}
```

### CSS Variables for Theming

```css
/* globals.css */
:root {
  --background: 0 0% 100%;
  --foreground: 240 10% 3.9%;
  --primary: 240 5.9% 10%;
  --primary-foreground: 0 0% 98%;
}

.dark {
  --background: 240 10% 3.9%;
  --foreground: 0 0% 98%;
  --primary: 0 0% 98%;
  --primary-foreground: 240 5.9% 10%;
}
```

## Testing Standards

### Test Structure

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('ComponentName', () => {
  // Setup
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Group related tests
  describe('rendering', () => {
    it('should render with default props', () => {
      render(<Component />);
      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('should display provided content', () => {
      render(<Component title="Test" />);
      expect(screen.getByText('Test')).toBeInTheDocument();
    });
  });

  describe('user interactions', () => {
    it('should handle click events', async () => {
      const user = userEvent.setup();
      const handleClick = vi.fn();

      render(<Component onClick={handleClick} />);

      await user.click(screen.getByRole('button'));

      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it('should update on input change', async () => {
      const user = userEvent.setup();
      render(<Component />);

      const input = screen.getByRole('textbox');
      await user.type(input, 'test value');

      expect(input).toHaveValue('test value');
    });
  });

  describe('async operations', () => {
    it('should load data successfully', async () => {
      render(<Component />);

      await waitFor(() => {
        expect(screen.getByText('Loaded')).toBeInTheDocument();
      });
    });
  });

  describe('edge cases', () => {
    it('should handle empty data', () => {
      render(<Component data={[]} />);
      expect(screen.getByText('No data')).toBeInTheDocument();
    });

    it('should handle errors gracefully', () => {
      render(<Component error={new Error('Test error')} />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
```

### Testing Best Practices

1. **Test behavior, not implementation**: Focus on what users see/do
2. **Use semantic queries**: getByRole, getByLabelText, getByText
3. **Avoid testing internals**: Don't test state directly
4. **Mock external dependencies**: API calls, timers, etc.
5. **Write descriptive test names**: Should read like documentation
6. **Keep tests independent**: No test should depend on another
7. **Test edge cases**: Empty states, errors, loading states

## Go Standards

### Code Organization

```go
// 1. Package documentation
// Package github provides GitHub API integration for issue management.
package github

// 2. Import grouping
import (
    // Standard library
    "context"
    "fmt"
    "time"

    // Third-party packages
    "github.com/google/go-github/v79/github"

    // Internal packages
    "github.com/goutils/pkg/config"
)

// 3. Constants first
const (
    maxRetries    = 3
    requestTimeout = 30 * time.Second
)

// 4. Type definitions
type Client struct {
    github *github.Client
    config *config.Config
}

// 5. Constructor functions
func NewClient(cfg *config.Config) (*Client, error) {
    if cfg == nil {
        return nil, errors.New("config is required")
    }

    return &Client{
        config: cfg,
    }, nil
}

// 6. Methods
func (c *Client) FetchIssues(ctx context.Context, owner, repo string) ([]*Issue, error) {
    // Implementation
}
```

### Error Handling

```go
// 1. Always handle errors
result, err := doSomething()
if err != nil {
    return fmt.Errorf("doSomething failed: %w", err)
}

// 2. Wrap errors with context
func (c *Client) FetchIssues(ctx context.Context, owner, repo string) ([]*Issue, error) {
    issues, _, err := c.github.Issues.ListByRepo(ctx, owner, repo, nil)
    if err != nil {
        return nil, fmt.Errorf("failed to fetch issues for %s/%s: %w", owner, repo, err)
    }
    return issues, nil
}

// 3. Use sentinel errors for known conditions
var ErrNotFound = errors.New("resource not found")

if err := findResource(id); errors.Is(err, ErrNotFound) {
    // Handle not found case
}

// 4. Custom error types for complex scenarios
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation failed for %s: %s", e.Field, e.Message)
}
```

## Security Standards

### Input Validation

```typescript
// Use Zod for runtime validation
import { z } from 'zod';

const RequestSchema = z.object({
  url: z.string().url('Invalid URL format'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  headers: z.array(z.object({
    key: z.string().min(1),
    value: z.string(),
  })),
  body: z.string().optional(),
});

function validateRequest(input: unknown) {
  return RequestSchema.safeParse(input);
}
```

### XSS Prevention

```typescript
// 1. Use React's built-in escaping (automatic)
<div>{userInput}</div> // Safe - React escapes

// 2. Avoid dangerouslySetInnerHTML
// Bad
<div dangerouslySetInnerHTML={{ __html: userInput }} />

// 3. Sanitize if HTML is required
import DOMPurify from 'dompurify';
const clean = DOMPurify.sanitize(userInput);
```

### Sensitive Data

```typescript
// 1. Never log sensitive data
console.log('Request:', { ...request, auth: '[REDACTED]' });

// 2. Clear sensitive data when done
const password = '';
// Use password
password = ''; // Clear it

// 3. Use secure storage
// Don't store secrets in localStorage
// Use environment variables for API keys
```

## Performance Guidelines

### React Performance

```typescript
// 1. Memoize expensive components
const ExpensiveList = memo(function ExpensiveList({ items }: Props) {
  return items.map(item => <Item key={item.id} {...item} />);
});

// 2. Use useMemo for expensive calculations
const sortedItems = useMemo(
  () => items.sort((a, b) => a.name.localeCompare(b.name)),
  [items]
);

// 3. Use useCallback for stable references
const handleClick = useCallback(() => {
  // handler
}, [dependencies]);

// 4. Lazy load heavy components
const Monaco = lazy(() => import('./MonacoEditor'));

// 5. Virtualize long lists
import { FixedSizeList } from 'react-window';
```

### Bundle Size

```typescript
// 1. Import only what you need
import { Button } from '@/components/ui/button'; // Good
import * as UI from '@/components/ui'; // Bad

// 2. Use dynamic imports
const Feature = dynamic(() => import('./Feature'), {
  loading: () => <Spinner />,
});

// 3. Tree-shake utilities
import { cn } from '@/lib/utils'; // Good - individual export
```

## Documentation Standards

### Code Comments

```typescript
/**
 * Executes an HTTP request with the given configuration.
 *
 * @param config - The request configuration
 * @param config.url - The target URL
 * @param config.method - HTTP method to use
 * @param config.timeout - Request timeout in milliseconds (default: 30000)
 * @returns Promise resolving to the response data
 * @throws {NetworkError} When the request fails due to network issues
 * @throws {TimeoutError} When the request exceeds the timeout
 *
 * @example
 * ```typescript
 * const response = await executeRequest({
 *   url: 'https://api.example.com/data',
 *   method: 'GET',
 *   timeout: 5000,
 * });
 * ```
 */
async function executeRequest(config: RequestConfig): Promise<Response> {
  // Implementation
}
```

### README Structure

1. **Title and badges**
2. **Brief description**
3. **Features list**
4. **Installation instructions**
5. **Quick start guide**
6. **Configuration options**
7. **API reference (if applicable)**
8. **Contributing guidelines**
9. **License**

---

Following these standards ensures consistency, maintainability, and quality across the Restura codebase.
