'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  exportDexieData,
  importDexieData,
  clearDexieStorage,
  getDexieStorageStats,
} from '@/lib/shared/dexie-storage';
import { db } from '@/lib/shared/database';
import { Download, Upload, Trash2, HardDrive, Shield } from 'lucide-react';

interface StorageStats {
  totalRecords: number;
  formattedSize: string;
  tables: Record<string, number>;
}

export function PrivacyControls() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Load stats on mount
  const loadStats = async () => {
    try {
      const storageStats = await getDexieStorageStats();
      setStats(storageStats);
    } catch (error) {
      console.error('Failed to load storage stats:', error);
    }
  };

  // Export all data
  const handleExport = async () => {
    setIsLoading(true);
    setMessage(null);

    try {
      const data = await exportDexieData();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `restura-backup-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setMessage({ type: 'success', text: 'Data exported successfully' });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Import data from file
  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setMessage(null);

    try {
      const text = await file.text();
      await importDexieData(text);
      await loadStats();

      setMessage({ type: 'success', text: 'Data imported successfully. Reload the app to see changes.' });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      setIsLoading(false);
      // Reset input
      event.target.value = '';
    }
  };

  // Clear all data
  const handleClearAll = async () => {
    setIsLoading(true);
    setMessage(null);

    try {
      await clearDexieStorage();
      await loadStats();

      setMessage({ type: 'success', text: 'All data cleared. Reload the app to reset.' });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Clear failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Secure delete (overwrite then delete)
  const handleSecureDelete = async () => {
    setIsLoading(true);
    setMessage(null);

    try {
      // First overwrite all tables with random data
      const tables = ['collections', 'environments', 'history', 'settings', 'cookies', 'workflows', 'workflowExecutions', 'fileCollections'] as const;

      for (const tableName of tables) {
        const table = db[tableName] as ReturnType<typeof db.table>;
        const records = await table.toArray();

        // Overwrite each record
        for (const record of records) {
          const randomData = crypto.getRandomValues(new Uint8Array(1024));
          const overwriteData = Array.from(randomData)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');

          const typedRecord = record as { id: string; name?: string; updatedAt?: number; encryptedData?: string };
          await table.put({
            id: typedRecord.id,
            name: typedRecord.name ?? '',
            updatedAt: 0,
            encryptedData: overwriteData,
          });
        }

        // Then clear the table
        await table.clear();
      }

      // Clear metadata
      await db.metadata.clear();

      // Clear localStorage migration status
      localStorage.removeItem('restura-dexie-migration-status');

      await loadStats();
      setMessage({ type: 'success', text: 'All data securely deleted. Reload the app to reset.' });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Secure delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Load stats when component mounts
  useEffect(() => {
    loadStats();
  }, []);

  return (
    <div className="border rounded-lg p-4">
      <div className="mb-4">
        <h3 className="flex items-center gap-2 font-semibold">
          <Shield className="h-5 w-5" />
          Privacy & Data Controls
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Your data is stored locally and encrypted. No data is sent to external servers.
        </p>
      </div>
      <div className="space-y-4">
        {/* Storage Stats */}
        {stats && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <HardDrive className="h-4 w-4" />
            <span>
              {stats.totalRecords} records ({stats.formattedSize})
            </span>
          </div>
        )}

        {/* Message */}
        {message && (
          <div
            className={`text-sm p-2 rounded ${
              message.type === 'success'
                ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
            }`}
          >
            {message.text}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {/* Export */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={isLoading}
          >
            <Download className="h-4 w-4 mr-2" />
            Export Data
          </Button>

          {/* Import */}
          <label>
            <Button
              variant="outline"
              size="sm"
              disabled={isLoading}
              asChild
            >
              <span>
                <Upload className="h-4 w-4 mr-2" />
                Import Data
              </span>
            </Button>
            <input
              type="file"
              accept=".json"
              onChange={handleImport}
              className="hidden"
            />
          </label>

          {/* Clear All */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={isLoading}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear All
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear All Data?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete all your collections, environments, history, and settings.
                  This action cannot be undone. Consider exporting your data first.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleClearAll}>
                  Clear All
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Secure Delete */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={isLoading}
              >
                <Shield className="h-4 w-4 mr-2" />
                Secure Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Secure Delete All Data?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will overwrite all data with random bytes before deleting, making recovery
                  impossible. Use this for maximum privacy when disposing of the app.
                  This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleSecureDelete}
                  className="bg-destructive text-destructive-foreground"
                >
                  Secure Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {/* Privacy Info */}
        <div className="text-xs text-muted-foreground mt-4 space-y-1">
          <p>All data is encrypted with AES-256-GCM before storage.</p>
          <p>Encryption keys are derived locally and never leave your device.</p>
          <p>No analytics, telemetry, or external network calls.</p>
        </div>
      </div>
    </div>
  );
}
