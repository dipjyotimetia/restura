'use client';

import { useEffect, useState } from 'react';

interface ClientHydrationProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * Defers rendering `children` until after the first client-side mount,
 * showing `fallback` in the meantime. Useful for subtrees whose output
 * depends on browser-only state that isn't available on the initial paint.
 */
export default function ClientHydration({ children, fallback = null }: ClientHydrationProps) {
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  if (!isHydrated) {
    return fallback;
  }

  return <>{children}</>;
}
