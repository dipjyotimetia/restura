import { useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, Info, X } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { CertificateOverride } from '@/features/http/components/CertificateOverride';
import { readFileAsText } from '@/lib/shared/file-utils';

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">
      {children}
    </p>
  );
}

export function CertificatesSettings() {
  const { settings, setClientCert, setCaCert } = useSettingsStore();
  const { clientCert, caCert } = settings;

  const [caFileName, setCaFileName] = useState<string>('');
  const [pastedCa, setPastedCa] = useState<string>(caCert?.pem ?? '');
  const caInputRef = useRef<HTMLInputElement>(null);

  const handleCaFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await readFileAsText(file);
    setCaFileName(file.name);
    setPastedCa('');
    setCaCert({ pem: text });
    e.target.value = '';
  };

  const handleCaPaste = (value: string) => {
    setPastedCa(value);
    setCaFileName('');
    if (value.trim()) {
      setCaCert({ pem: value.trim() });
    } else {
      setCaCert(undefined);
    }
  };

  const handleClearCaCert = () => {
    setCaCert(undefined);
    setCaFileName('');
    setPastedCa('');
    if (caInputRef.current) caInputRef.current.value = '';
  };

  const hasCaCert = !!caCert?.pem;

  return (
    <div className="space-y-6">
      {/* ── Section A: Client Certificate ─────────────────────────────── */}
      <div className="space-y-4">
        <SectionHeader>Client Certificate (mTLS)</SectionHeader>

        <CertificateOverride clientCert={clientCert} onCertChange={setClientCert} />

        <div className="flex items-start gap-2 rounded bg-muted border border-border p-3">
          <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground font-mono">
            Client certificates are only used in the desktop app.
          </p>
        </div>
      </div>

      {/* ── Section B: Custom CA Certificate ──────────────────────────── */}
      <div className="space-y-4">
        <SectionHeader>Custom CA Certificate</SectionHeader>

        <div className="space-y-1.5">
          <Label className="text-xs font-mono">CA Certificate File (.pem / .crt / .cer)</Label>
          <div className="flex items-center gap-2">
            <input
              ref={caInputRef}
              type="file"
              accept=".pem,.crt,.cer"
              onChange={handleCaFileSelect}
              className="hidden"
              id="ca-upload"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="font-mono text-xs"
              onClick={() => caInputRef.current?.click()}
            >
              Choose File
            </Button>
            {caFileName ? (
              <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                {caFileName}
              </span>
            ) : hasCaCert && !pastedCa ? (
              <span className="text-xs text-muted-foreground">(loaded)</span>
            ) : (
              <span className="text-xs text-muted-foreground">No file chosen</span>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ca-pem-paste" className="text-xs font-mono">
            Or paste PEM directly
          </Label>
          <Textarea
            id="ca-pem-paste"
            value={pastedCa}
            onChange={(e) => handleCaPaste(e.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
            className="font-mono text-xs resize-none h-28 bg-background border-border"
          />
          {pastedCa && (
            <p className="text-xs text-muted-foreground">Source: (pasted)</p>
          )}
        </div>

        {hasCaCert && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="font-mono text-xs gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={handleClearCaCert}
          >
            <X className="h-3 w-3" />
            Clear CA Certificate
          </Button>
        )}

        <div
          className="flex items-start gap-2 rounded bg-amber-500/10 border border-amber-500/20 p-3"
          role="alert"
        >
          <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-400 font-mono">
            This CA replaces the system trust store for these requests. Only use for internal or development CA certificates.
          </p>
        </div>
      </div>
    </div>
  );
}
