import { useEffect } from 'react';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { toast, Toaster } from 'sonner';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { AccentProvider } from '@/components/providers/AccentProvider';
import { PlatformProvider } from '@/components/providers/PlatformProvider';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { KeychainStatusBanner } from '@/components/shared/KeychainStatusBanner';
import { UpdateNotification } from '@/components/shared/UpdateNotification';
import AriaLiveAnnouncerProvider from '@/components/shared/AriaLiveAnnouncer';
import Home from '@/routes/index';
import NotFound from '@/routes/not-found';
import { lazyComponent } from '@/lib/shared/lazyComponent';

// AI Lab is a separate full-screen route (its own workbench), lazy-loaded so its
// tree stays out of the main entry chunk.
const AiLabWorkspace = lazyComponent(() => import('@/features/ai-lab/components/AiLabWorkspace'));

const router = createHashRouter([
  {
    path: '/',
    element: <Home />,
    errorElement: <NotFound />,
  },
  {
    path: '/ai-lab',
    element: <AiLabWorkspace />,
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
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <ErrorBoundary>
          <AccentProvider>
            <AriaLiveAnnouncerProvider>
              <PlatformProvider>
                <UpdateNotification />
                <KeychainStatusBanner />
                <RouterProvider router={router} />
              </PlatformProvider>
            </AriaLiveAnnouncerProvider>
          </AccentProvider>
        </ErrorBoundary>
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          theme="dark"
          toastOptions={{
            className: 'border border-sp-line-strong',
            style: {
              background: 'var(--sp-surface-hi)',
              color: 'var(--sp-text)',
            },
          }}
        />
      </ThemeProvider>
    </>
  );
}
