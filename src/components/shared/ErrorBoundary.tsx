/**
 * Error Boundary Component with React 19 Patterns
 *
 * Features:
 * - Class-based error boundary (still required in React 19)
 * - Hook-based error handler for functional components
 * - Key-based error reset support
 * - Enhanced error reporting
 * - Development mode stack traces
 */

import {
  Component,
  type ReactNode,
  type ComponentType,
  type ErrorInfo,
  createContext,
  useContext,
  useCallback,
  useState,
  useMemo,
} from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle, RefreshCw, Bug, Copy, Check } from 'lucide-react';

// ============================================================================
// Error Boundary Context
// ============================================================================

interface ErrorBoundaryContextValue {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  resetError: () => void;
  showError: (error: Error) => void;
}

const ErrorBoundaryContext = createContext<ErrorBoundaryContextValue | null>(null);

/**
 * Hook to access error boundary context
 * Allows functional components to interact with the error boundary
 */
export function useErrorBoundary(): ErrorBoundaryContextValue {
  const context = useContext(ErrorBoundaryContext);
  if (!context) {
    // Provide a fallback for components outside error boundary
    return {
      error: null,
      errorInfo: null,
      resetError: () => {},
      showError: (error: Error) => {
        throw error;
      },
    };
  }
  return context;
}

// ============================================================================
// Error Boundary Component
// ============================================================================

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((props: FallbackProps) => ReactNode);
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onReset?: () => void;
  resetKeys?: unknown[];
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export interface FallbackProps {
  error: Error;
  errorInfo: ErrorInfo | null;
  resetError: () => void;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    // Log error in development
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary] Caught error:', error);
      console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);
    }

    // Call custom error handler
    this.props.onError?.(error, errorInfo);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Reset error when resetKeys change
    if (this.state.hasError && this.props.resetKeys) {
      const keysChanged = this.props.resetKeys.some(
        (key, index) => prevProps.resetKeys?.[index] !== key
      );
      if (keysChanged) {
        this.handleReset();
      }
    }
  }

  handleReset = (): void => {
    this.props.onReset?.();
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  showError = (error: Error): void => {
    this.setState({
      hasError: true,
      error,
      errorInfo: null,
    });
  };

  override render(): ReactNode {
    const { hasError, error, errorInfo } = this.state;
    const { children, fallback } = this.props;

    const contextValue: ErrorBoundaryContextValue = {
      error,
      errorInfo,
      resetError: this.handleReset,
      showError: this.showError,
    };

    if (hasError && error) {
      // Custom fallback render function
      if (typeof fallback === 'function') {
        return (
          <ErrorBoundaryContext.Provider value={contextValue}>
            {fallback({ error, errorInfo, resetError: this.handleReset })}
          </ErrorBoundaryContext.Provider>
        );
      }

      // Custom fallback element
      if (fallback) {
        return (
          <ErrorBoundaryContext.Provider value={contextValue}>
            {fallback}
          </ErrorBoundaryContext.Provider>
        );
      }

      // Default fallback
      return (
        <ErrorBoundaryContext.Provider value={contextValue}>
          <DefaultErrorFallback
            error={error}
            errorInfo={errorInfo}
            resetError={this.handleReset}
          />
        </ErrorBoundaryContext.Provider>
      );
    }

    return (
      <ErrorBoundaryContext.Provider value={contextValue}>
        {children}
      </ErrorBoundaryContext.Provider>
    );
  }
}

// ============================================================================
// Default Error Fallback Component
// ============================================================================

function DefaultErrorFallback({ error, errorInfo, resetError }: FallbackProps): ReactNode {
  const [copied, setCopied] = useState(false);

  const copyErrorDetails = useCallback(async () => {
    const details = [
      `Error: ${error.name}`,
      `Message: ${error.message}`,
      `Stack: ${error.stack || 'N/A'}`,
      errorInfo ? `Component Stack: ${errorInfo.componentStack}` : '',
    ].join('\n\n');

    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      console.error('Failed to copy error details');
    }
  }, [error, errorInfo]);

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center p-8">
      <div className="max-w-md space-y-6 text-center">
        <div className="flex justify-center">
          <div className="rounded-full bg-destructive/10 p-4">
            <AlertTriangle className="h-12 w-12 text-destructive" />
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">Something went wrong</h2>
          <p className="text-muted-foreground">
            An unexpected error occurred. Please try again or refresh the page.
          </p>
        </div>

        {import.meta.env.DEV && (
          <div className="rounded-lg bg-muted p-4 text-left">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bug className="h-4 w-4 text-destructive" />
                <span className="text-sm font-semibold text-destructive">
                  Development Error Details
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={copyErrorDetails}
              >
                {copied ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </div>
            <p className="mb-2 font-mono text-sm text-destructive">
              {error.name}: {error.message}
            </p>
            {errorInfo && (
              <pre className="max-h-40 overflow-auto text-xs text-muted-foreground">
                {errorInfo.componentStack}
              </pre>
            )}
          </div>
        )}

        <div className="flex justify-center gap-3">
          <Button onClick={resetError} variant="default">
            <RefreshCw className="mr-2 h-4 w-4" />
            Try Again
          </Button>
          <Button onClick={() => window.location.reload()} variant="outline">
            Reload Page
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// HOC for Wrapping Components
// ============================================================================

/**
 * Higher-order component for wrapping components with error boundary
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: ComponentType<P>,
  options?: Omit<ErrorBoundaryProps, 'children'>
) {
  const displayName = WrappedComponent.displayName || WrappedComponent.name || 'Component';

  function ComponentWithErrorBoundary(props: P) {
    return (
      <ErrorBoundary {...options}>
        <WrappedComponent {...props} />
      </ErrorBoundary>
    );
  }

  ComponentWithErrorBoundary.displayName = `withErrorBoundary(${displayName})`;

  return ComponentWithErrorBoundary;
}

// ============================================================================
// Suspense-like Error Boundary for Async Operations
// ============================================================================

interface AsyncBoundaryProps {
  children: ReactNode;
  errorFallback?: ReactNode | ((props: FallbackProps) => ReactNode);
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

/**
 * Combines Suspense-like loading with Error Boundary
 * Useful for async operations that might fail
 */
export function AsyncBoundary({
  children,
  errorFallback,
  onError,
}: AsyncBoundaryProps): ReactNode {
  return (
    <ErrorBoundary fallback={errorFallback} onError={onError}>
      {children}
    </ErrorBoundary>
  );
}

// ============================================================================
// Hook for Triggering Error Boundary
// ============================================================================

/**
 * Hook that provides a function to trigger the nearest error boundary
 * Useful for handling async errors in event handlers
 */
export function useErrorHandler(): (error: Error) => void {
  const { showError } = useErrorBoundary();

  return useCallback(
    (error: Error) => {
      showError(error);
    },
    [showError]
  );
}

// ============================================================================
// Error Boundary for Specific Error Types
// ============================================================================

interface TypedErrorBoundaryProps<E extends Error> extends ErrorBoundaryProps {
  errorType: new (...args: unknown[]) => E;
  onTypedError?: (error: E, errorInfo: ErrorInfo) => void;
}

/**
 * Error boundary that only catches specific error types
 */
export function TypedErrorBoundary<E extends Error>({
  errorType,
  onTypedError,
  onError,
  ...props
}: TypedErrorBoundaryProps<E>): ReactNode {
  const handleError = useCallback(
    (error: Error, errorInfo: ErrorInfo) => {
      if (error instanceof errorType) {
        onTypedError?.(error as E, errorInfo);
      }
      onError?.(error, errorInfo);
    },
    [errorType, onTypedError, onError]
  );

  return <ErrorBoundary {...props} onError={handleError} />;
}

// ============================================================================
// Query Error Reset Boundary (for react-query integration)
// ============================================================================

interface QueryErrorResetBoundaryProps {
  children: ReactNode;
  onReset?: () => void;
}

/**
 * Error boundary designed to work with data fetching libraries
 * Provides reset functionality that can be used to refetch data
 */
export function QueryErrorResetBoundary({
  children,
  onReset,
}: QueryErrorResetBoundaryProps): ReactNode {
  const [resetKey, setResetKey] = useState(0);

  const handleReset = useCallback(() => {
    setResetKey((prev) => prev + 1);
    onReset?.();
  }, [onReset]);

  const contextValue = useMemo(
    () => ({
      resetKey,
      reset: handleReset,
    }),
    [resetKey, handleReset]
  );

  return (
    <QueryErrorResetContext.Provider value={contextValue}>
      <ErrorBoundary resetKeys={[resetKey]} onReset={handleReset}>
        {children}
      </ErrorBoundary>
    </QueryErrorResetContext.Provider>
  );
}

interface QueryErrorResetContextValue {
  resetKey: number;
  reset: () => void;
}

const QueryErrorResetContext = createContext<QueryErrorResetContextValue>({
  resetKey: 0,
  reset: () => {},
});

/**
 * Hook to access query error reset functionality
 */
export function useQueryErrorResetBoundary(): QueryErrorResetContextValue {
  return useContext(QueryErrorResetContext);
}
