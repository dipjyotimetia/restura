'use client';

import { useEffect, useState } from 'react';

interface ClientHydrationProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * ClientHydration wrapper to prevent SSR/CSR hydration mismatches.
 * Ensures children only render after client-side hydration is complete.
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
