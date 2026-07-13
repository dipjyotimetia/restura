import { useTheme } from 'next-themes';
import { useEffect } from 'react';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { toast, Toaster } from 'sonner';
import { AccentProvider } from '@/components/providers/AccentProvider';
import { PlatformProvider } from '@/components/providers/PlatformProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import AriaLiveAnnouncerProvider from '@/components/shared/AriaLiveAnnouncer';
import { CaptureImportListener } from '@/components/shared/CaptureImportListener';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { KeychainStatusBanner } from '@/components/shared/KeychainStatusBanner';
import { UpdateNotification } from '@/components/shared/UpdateNotification';
import { MotionProvider } from '@/components/ui/motion';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import Home from '@/routes/index';
import NotFound from '@/routes/not-found';
import { useCollectionStore } from '@/store/useCollectionStore';
import {
  useFileCollectionStore,
  isElectronEnvironment,
  restoreFileCollectionWatchers,
  initFileCollectionWatcher,
  cleanupFileCollectionWatcher,
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

// Rendered inside <ThemeProvider> so it can read the resolved theme via
// useTheme(); App itself is the provider's parent and cannot. Keeps toasts in
// the active palette instead of being hardcoded to dark.
function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="bottom-right"
      richColors
      closeButton
      theme={(resolvedTheme ?? 'dark') as 'light' | 'dark'}
      toastOptions={{
        className: 'bg-sp-surface-hi border border-sp-line-strong',
        style: {
          color: 'var(--sp-text)',
        },
      }}
    />
  );
}

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
  useEffect(() => {
    if (!isElectronEnvironment()) return;
    let ran = false;
    const run = () => {
      if (
        ran ||
        !useFileCollectionStore.persist.hasHydrated() ||
        !useCollectionStore.persist.hasHydrated()
      )
        return;
      ran = true;
      initFileCollectionWatcher();
      void restoreFileCollectionWatchers();
    };
    const unsubFiles = useFileCollectionStore.persist.onFinishHydration(run);
    const unsubCollections = useCollectionStore.persist.onFinishHydration(run);
    run();
    return () => {
      unsubFiles();
      unsubCollections();
      cleanupFileCollectionWatcher();
    };
  }, []);

  return (
    <>
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem
        enableColorScheme
        disableTransitionOnChange
      >
        <ErrorBoundary>
          <MotionProvider>
            <AccentProvider>
              <AriaLiveAnnouncerProvider>
                <PlatformProvider>
                  <UpdateNotification />
                  <KeychainStatusBanner />
                  <CaptureImportListener />
                  <RouterProvider router={router} />
                </PlatformProvider>
              </AriaLiveAnnouncerProvider>
            </AccentProvider>
          </MotionProvider>
        </ErrorBoundary>
        <ThemedToaster />
      </ThemeProvider>
    </>
  );
}
