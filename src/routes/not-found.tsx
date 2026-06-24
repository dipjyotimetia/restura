import { Home, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="text-center space-y-8 max-w-sm">
        {/* Glow number */}
        <div>
          <span
            className="text-9xl font-mono font-bold text-primary block leading-none"
            style={{
              textShadow: '0 0 40px var(--sp-accent), 0 0 80px var(--sp-accent)',
            }}
            aria-label="Error 404"
          >
            404
          </span>
        </div>

        <div className="space-y-2">
          <p className="text-lg font-mono text-foreground">This endpoint doesn&apos;t exist.</p>
          <p className="text-xs font-mono text-muted-foreground/50">
            The route you&apos;re looking for returned no content.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button asChild variant="glow" size="sm" className="font-mono text-xs gap-2">
            <Link to="/">
              <Home className="h-3.5 w-3.5" />
              Go Home
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="font-mono text-xs gap-2"
            onClick={() => window.history.back()}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Go Back
          </Button>
        </div>
      </div>
    </div>
  );
}
