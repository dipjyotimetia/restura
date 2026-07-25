import * as React from 'react';
import { Database, Download, type LucideIcon, Trash2, Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Floater } from '@/components/ui/spatial';
import { useStorageMonitor } from '@/hooks/useStorageMonitor';
import {
  clearDexieStorage,
  exportDexieData,
  importDexieData,
  secureDeleteAllDexieData,
} from '@/lib/shared/dexie-storage';
import { downloadBlob } from '@/lib/shared/file-utils';
import { cn } from '@/lib/shared/utils';
import { SectionHeader, SectionLabel } from '../components/SettingsSectionPrimitives';

function DataButton({
  onClick,
  disabled,
  icon: Icon,
  danger,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  icon: LucideIcon;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn text-sp-12 font-medium border',
        'transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        danger
          ? 'border-rose-500/30 bg-rose-500/5 text-rose-500 dark:text-rose-400 hover:bg-rose-500/10 hover:border-rose-400/60'
          : 'border-sp-line bg-sp-surface text-sp-text hover:bg-sp-hover'
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {children}
    </button>
  );
}

export function DataSection() {
  // autoPrune:false — this is a display-only usage indicator; don't silently
  // prune history just because the user opened the Data tab.
  const { status, checkStorage, formattedUsed, formattedAvailable } = useStorageMonitor({
    autoPrune: false,
  });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'clear' | 'secure'>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (action: () => Promise<void>, success: string, failPrefix: string): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        await checkStorage();
        toast.success(success);
        return true;
      } catch (e) {
        toast.error(`${failPrefix}: ${e instanceof Error ? e.message : 'Unknown error'}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [checkStorage]
  );

  // Import / clear / secure-delete rewrite Dexie out from under the in-memory
  // Zustand stores, which would otherwise re-persist their stale state over the
  // new rows. Reload once the success toast has had a moment to show so the
  // freshly persisted data is what boots.
  const reloadAfter = (ok: boolean) => {
    if (ok) setTimeout(() => window.location.reload(), 900);
  };

  const handleExport = () =>
    run(
      async () =>
        downloadBlob(
          await exportDexieData(),
          `restura-backup-${new Date().toISOString().split('T')[0]}.json`
        ),
      'Data exported',
      'Export failed'
    );

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void run(
      async () => importDexieData(await file.text()),
      'Data imported — reloading…',
      'Import failed'
    ).then(reloadAfter);
  };

  const confirmDestructive = () => {
    const which = confirm;
    setConfirm(null);
    if (which === 'clear') {
      void run(clearDexieStorage, 'All data cleared — reloading…', 'Clear failed').then(
        reloadAfter
      );
    } else if (which === 'secure') {
      void run(
        secureDeleteAllDexieData,
        'All data securely deleted — reloading…',
        'Secure delete failed'
      ).then(reloadAfter);
    }
  };

  const levelColor =
    status.level === 'critical'
      ? '#f43f5e'
      : status.level === 'warning'
        ? '#f59e0b'
        : 'var(--sp-accent)';

  return (
    <>
      <SectionHeader
        icon={Database}
        title="Data"
        description="Back up, restore, or wipe your locally stored data. Everything stays on this device."
      />

      <section className="mt-5 first:mt-0">
        <SectionLabel>Storage usage</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4 space-y-2">
          <div className="flex items-center justify-between text-sp-12 font-mono text-sp-muted">
            <span>
              {status.totalRecords} records · {formattedUsed}
            </span>
            <span>
              {status.percentage.toFixed(1)}% of {formattedAvailable}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-sp-line overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                // Floor the width so a non-empty store still shows a sliver of fill
                // (0.0% of a 10 GB quota would otherwise render an empty track).
                width: `${status.totalRecords > 0 ? Math.max(2, Math.min(100, status.percentage)) : 0}%`,
                background: levelColor,
              }}
            />
          </div>
          {status.message && (
            <p className="text-sp-11 text-amber-500 dark:text-amber-400">{status.message}</p>
          )}
        </Floater>
      </section>

      <section className="mt-5">
        <SectionLabel>Backup</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4 flex flex-wrap gap-2">
          <DataButton onClick={() => void handleExport()} disabled={busy} icon={Download}>
            Export data
          </DataButton>
          <DataButton onClick={() => fileInputRef.current?.click()} disabled={busy} icon={Upload}>
            Import data
          </DataButton>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
            aria-label="Import data file"
          />
        </Floater>
      </section>

      <section className="mt-5">
        <SectionLabel>Danger zone</SectionLabel>
        <Floater radius="panel" elevation="inset" className="p-4 flex flex-wrap gap-2">
          <DataButton onClick={() => setConfirm('clear')} disabled={busy} icon={Trash2} danger>
            Clear all data
          </DataButton>
          <DataButton onClick={() => setConfirm('secure')} disabled={busy} icon={Trash2} danger>
            Secure delete
          </DataButton>
        </Floater>
      </section>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        variant="destructive"
        title={confirm === 'secure' ? 'Securely delete all data?' : 'Clear all data?'}
        description={
          confirm === 'secure'
            ? 'Overwrites every stored record with random data before deleting it, then wipes the database — for use on a shared machine. This cannot be undone.'
            : 'Permanently deletes all collections, history, environments, and settings from this device. This cannot be undone.'
        }
        confirmText={confirm === 'secure' ? 'Secure delete' : 'Clear all'}
        onConfirm={confirmDestructive}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shortcuts                                                                  */
/* -------------------------------------------------------------------------- */
