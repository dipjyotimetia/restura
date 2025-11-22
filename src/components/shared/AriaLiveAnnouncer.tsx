'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface AnnouncerContextType {
  announce: (message: string, priority?: 'polite' | 'assertive') => void;
  announceStatus: (status: string) => void;
  announceError: (error: string) => void;
  announceSuccess: (success: string) => void;
}

const AnnouncerContext = createContext<AnnouncerContextType | null>(null);

export function useAnnouncer() {
  const context = useContext(AnnouncerContext);
  if (!context) {
    throw new Error('useAnnouncer must be used within AriaLiveAnnouncerProvider');
  }
  return context;
}

interface AriaLiveAnnouncerProviderProps {
  children: ReactNode;
}

export default function AriaLiveAnnouncerProvider({ children }: AriaLiveAnnouncerProviderProps) {
  const [politeMessage, setPoliteMessage] = useState('');
  const [assertiveMessage, setAssertiveMessage] = useState('');

  const announce = useCallback((message: string, priority: 'polite' | 'assertive' = 'polite') => {
    if (priority === 'assertive') {
      // Clear first to ensure announcement even if same message
      setAssertiveMessage('');
      setTimeout(() => setAssertiveMessage(message), 50);
    } else {
      setPoliteMessage('');
      setTimeout(() => setPoliteMessage(message), 50);
    }
  }, []);

  const announceStatus = useCallback(
    (status: string) => {
      announce(`Status: ${status}`, 'polite');
    },
    [announce]
  );

  const announceError = useCallback(
    (error: string) => {
      announce(`Error: ${error}`, 'assertive');
    },
    [announce]
  );

  const announceSuccess = useCallback(
    (success: string) => {
      announce(success, 'polite');
    },
    [announce]
  );

  return (
    <AnnouncerContext.Provider value={{ announce, announceStatus, announceError, announceSuccess }}>
      {children}

      {/* Polite live region for non-urgent announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {politeMessage}
      </div>

      {/* Assertive live region for urgent announcements */}
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      >
        {assertiveMessage}
      </div>
    </AnnouncerContext.Provider>
  );
}

// Hook to announce request status changes
export function useRequestAnnouncements() {
  const { announceStatus, announceError, announceSuccess } = useAnnouncer();

  const announceRequestSent = useCallback(() => {
    announceStatus('Request sent, waiting for response');
  }, [announceStatus]);

  const announceRequestComplete = useCallback(
    (status: number, time: number) => {
      if (status >= 200 && status < 300) {
        announceSuccess(`Request completed successfully with status ${status} in ${time} milliseconds`);
      } else if (status >= 400) {
        announceError(`Request failed with status ${status} in ${time} milliseconds`);
      } else {
        announceStatus(`Request completed with status ${status} in ${time} milliseconds`);
      }
    },
    [announceSuccess, announceError, announceStatus]
  );

  const announceRequestFailed = useCallback(
    (error: string) => {
      announceError(`Request failed: ${error}`);
    },
    [announceError]
  );

  return {
    announceRequestSent,
    announceRequestComplete,
    announceRequestFailed,
  };
}
