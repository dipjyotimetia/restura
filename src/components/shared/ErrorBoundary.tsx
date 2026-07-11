'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Component } from 'react';
import { Button } from '@/components/ui/button';
import { recordRuntimeError } from '@/lib/shared/bug-report';
import { isElectron } from '@/lib/shared/platform';
import { reportError } from '@/lib/shared/telemetry';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    recordRuntimeError({
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      source: 'error-boundary',
    });
    this.setState({ errorInfo });

    // Call custom error handler if provided
    this.props.onError?.(error, errorInfo);

    // Opt-out telemetry (on by default, gated on settings.telemetry.errorsEnabled).
    reportError({
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
      source: 'error-boundary',
      ...(errorInfo.componentStack ? { componentStack: errorInfo.componentStack } : {}),
    });

    // On Electron, reportError() exits early (file:// protocol, no Worker).
    // componentDidCatch *swallows* the error, so it never reaches Sentry's
    // default uncaught-exception handler — forward it explicitly.
    if (isElectron()) {
      void import('@sentry/electron/renderer').then((Sentry) =>
        Sentry.captureException(error, {
          contexts: { react: { componentStack: errorInfo.componentStack ?? '' } },
        })
      );
    }
  }

  handleReset = (): void => {
    // EOPT: omit `error`/`errorInfo` keys to clear them rather than setting
    // them to undefined.
    this.setState({ hasError: false } as State);
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

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

            {process.env.NODE_ENV === 'development' && this.state.error && (
              <div className="rounded-lg bg-muted p-4 text-left">
                <p className="mb-2 font-mono text-sm font-semibold text-destructive">
                  {this.state.error.name}: {this.state.error.message}
                </p>
                {this.state.errorInfo && (
                  <pre className="max-h-40 overflow-auto text-xs text-muted-foreground">
                    {this.state.errorInfo.componentStack}
                  </pre>
                )}
              </div>
            )}

            <div className="flex justify-center gap-3">
              <Button onClick={this.handleReset} variant="default">
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

    return this.props.children;
  }
}

// HOC for wrapping components with error boundary
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  fallback?: ReactNode
) {
  const displayName = WrappedComponent.displayName || WrappedComponent.name || 'Component';

  const ComponentWithErrorBoundary = (props: P) => (
    <ErrorBoundary fallback={fallback}>
      <WrappedComponent {...props} />
    </ErrorBoundary>
  );

  ComponentWithErrorBoundary.displayName = `withErrorBoundary(${displayName})`;

  return ComponentWithErrorBoundary;
}
