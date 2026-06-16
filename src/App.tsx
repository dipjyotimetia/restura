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
import {
  useFileCollectionStore,
  isElectronEnvironment,
  restoreFileCollectionWatchers,
} from '@/store/useFileCollectionStore';

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

  // Desktop only: re-establish file-collection watchers on launch. The main
  // process keeps the git allowlist as its set of live watchers (in-memory, lost
  // on restart) while the collections persist — so without this every git op on
  // a previously-opened collection fails until the user re-opens the folder. Run
  // after the file-collection store hydrates from Dexie.
  //
  // NOTE: this intentionally does NOT call initFileCollectionWatcher() — that
  // subscribes the renderer to file-change events and, lacking self-write
  // suppression, would flag the app's own saves as external conflicts. Restoring
  // the watchers alone is enough to fix the git allowlist; the conflict-detection
  // path stays dormant (its prior state) until it's finished separately.
  useEffect(() => {
    if (!isElectronEnvironment()) return;
    let ran = false;
    const run = () => {
      if (ran) return;
      ran = true;
      void restoreFileCollectionWatchers();
    };
    const unsub = useFileCollectionStore.persist.onFinishHydration(run);
    if (useFileCollectionStore.persist.hasHydrated()) run();
    return () => {
      unsub();
    };
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
            className: 'glass-1 border border-sp-line-strong',
            style: {
              color: 'var(--sp-text)',
            },
          }}
        />
      </ThemeProvider>
    </>
  );
}
