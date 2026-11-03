import { AlertTriangle, RefreshCw } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
import { isRouteErrorResponse, useLocation, useNavigate, useRouteError } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { recordRuntimeError } from '@/lib/shared/bug-report';
import { isElectron } from '@/lib/shared/platform';
import { reportError } from '@/lib/shared/telemetry';
import NotFound from '@/routes/not-found';

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : 'Unknown route error');
}

/**
 * Route `errorElement`. React Router catches render errors inside a route
 * before the app-level ErrorBoundary sees them, so this must report them the
 * same way (bug-report buffer, telemetry, Sentry on desktop) and offer a reset
 * — not disguise a crash as a 404. A genuine 404 response still renders NotFound.
 */
export function RouteErrorBoundary(): ReactElement {
  const routeError = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  const notFound = isRouteErrorResponse(routeError) && routeError.status === 404;

  useEffect(() => {
    if (notFound) return;
    const error = toError(routeError);
    console.error('Route error:', error);
    recordRuntimeError({
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      source: 'route-error',
    });
    reportError({
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
      source: 'error-boundary',
    });
    // reportError() exits early on Electron (file://, no Worker): forward to Sentry.
    if (isElectron()) {
      void import('@sentry/electron/renderer').then((Sentry) => Sentry.captureException(error));
    }
  }, [routeError, notFound]);

  if (notFound) return <NotFound />;

  // A new location object resets React Router's route error state.
  const retry = () =>
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true }
    );

  return (
    <div role="alert" className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="max-w-md space-y-6 text-center">
        <div className="flex justify-center">
          <div className="rounded-full bg-destructive/10 p-4">
            <AlertTriangle className="h-12 w-12 text-destructive" aria-hidden />
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">Something went wrong</h2>
          <p className="text-muted-foreground">
            An unexpected error occurred. Please try again or refresh the page.
          </p>
        </div>
        <div className="flex justify-center gap-3">
          <Button onClick={retry} variant="default">
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
