import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { PlatformProvider } from '@/components/providers/PlatformProvider';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import AriaLiveAnnouncerProvider from '@/components/shared/AriaLiveAnnouncer';
import { Toaster } from 'sonner';
import Home from '@/pages/Home';

export default function App() {
  return (
    <>
      {/* Gradient background */}
      <div className="gradient-mesh-bg">
        <div className="gradient-orb gradient-orb-1" />
        <div className="gradient-orb gradient-orb-2" />
        <div className="gradient-orb gradient-orb-3" />
      </div>

      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem
        disableTransitionOnChange
      >
        <ErrorBoundary>
          <AriaLiveAnnouncerProvider>
            <PlatformProvider>
              <Home />
            </PlatformProvider>
          </AriaLiveAnnouncerProvider>
        </ErrorBoundary>
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          theme="system"
          toastOptions={{
            style: {
              background: 'hsl(var(--background))',
              border: '1px solid hsl(var(--border))',
              color: 'hsl(var(--foreground))',
            },
          }}
        />
      </ThemeProvider>
    </>
  );
}
