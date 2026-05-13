import { useEffect } from 'react';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { toast, Toaster } from 'sonner';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { PlatformProvider } from '@/components/providers/PlatformProvider';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import AriaLiveAnnouncerProvider from '@/components/shared/AriaLiveAnnouncer';
import Home from '@/routes/index';
import NotFound from '@/routes/not-found';

const router = createHashRouter([
  {
    path: '/',
    element: <Home />,
    errorElement: <NotFound />,
  },
  {
    path: '*',
    element: <NotFound />,
  },
]);

export default function App() {
  useEffect(() => {
    const handler = () => {
      toast.error('Storage full', {
        description: 'Browser storage is full. Delete history or collections to free space.',
      });
    };
    window.addEventListener('restura:storage-quota-exceeded', handler);
    return () => window.removeEventListener('restura:storage-quota-exceeded', handler);
  }, []);

  return (
    <>
      <div className="noise-texture fixed inset-0 pointer-events-none z-[-1]" />
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem
        disableTransitionOnChange
      >
        <ErrorBoundary>
          <AriaLiveAnnouncerProvider>
            <PlatformProvider>
              <RouterProvider router={router} />
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
