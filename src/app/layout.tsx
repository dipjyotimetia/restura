import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { PlatformProvider } from '@/components/providers/PlatformProvider';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import AriaLiveAnnouncerProvider from '@/components/shared/AriaLiveAnnouncer';
import { Toaster } from 'sonner';

export const metadata: Metadata = {
  title: 'Restura - Multi-Protocol API Testing Tool',
  description: 'A modern API client for testing HTTP, GraphQL, gRPC, and WebSocket endpoints. Features include collections, environments, pre-request scripts, and code generation.',
  keywords: ['API testing', 'HTTP client', 'GraphQL', 'gRPC', 'WebSocket', 'REST API', 'API development'],
  authors: [{ name: 'Restura' }],
  creator: 'Restura',
  publisher: 'Restura',
  applicationName: 'Restura',
  metadataBase: new URL('https://restura.dev'),
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'Restura',
    title: 'Restura - Multi-Protocol API Testing Tool',
    description: 'A modern API client for testing HTTP, GraphQL, gRPC, and WebSocket endpoints.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Restura - Multi-Protocol API Testing Tool',
    description: 'A modern API client for testing HTTP, GraphQL, gRPC, and WebSocket endpoints.',
  },
  robots: {
    index: true,
    follow: true,
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
  viewport: {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
  },
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
