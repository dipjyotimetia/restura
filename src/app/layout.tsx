import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/ThemeProvider';
import { PlatformProvider } from '@/components/PlatformProvider';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import AriaLiveAnnouncerProvider from '@/components/AriaLiveAnnouncer';
import { Toaster } from 'sonner';

export const metadata: Metadata = {
  title: 'Restura - Multi-Protocol API Testing Tool',
  description: 'Restura - A modern API client for testing HTTP and gRPC endpoints',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
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
              <PlatformProvider>{children}</PlatformProvider>
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
      </body>
    </html>
  );
}
