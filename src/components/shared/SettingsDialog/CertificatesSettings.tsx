import { useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, Info, X } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { readFileAsBase64, readFileAsText } from '@/lib/shared/file-utils';

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

  const [certFormat, setCertFormat] = useState<'pfx' | 'pem'>(
    clientCert?.format ?? 'pfx'
  );

  // Track filenames for display
  const [pfxFileName, setPfxFileName] = useState<string>('');
  const [pemCertFileName, setPemCertFileName] = useState<string>('');
  const [pemKeyFileName, setPemKeyFileName] = useState<string>('');
  const [caFileName, setCaFileName] = useState<string>('');
  const [pastedCa, setPastedCa] = useState<string>(caCert?.pem ?? '');

  const pfxInputRef = useRef<HTMLInputElement>(null);
  const pemCertInputRef = useRef<HTMLInputElement>(null);
  const pemKeyInputRef = useRef<HTMLInputElement>(null);
  const caInputRef = useRef<HTMLInputElement>(null);

  // ── PFX handlers ──────────────────────────────────────────────────────────

  const handlePfxSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const base64 = await readFileAsBase64(file);
    setPfxFileName(file.name);
    setClientCert({
      format: 'pfx',
      pfx: base64,
      passphrase: clientCert?.passphrase,
    });
    e.target.value = '';
  };

  // ── PEM handlers ──────────────────────────────────────────────────────────

  const handlePemCertSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await readFileAsText(file);
    setPemCertFileName(file.name);
    setClientCert({
      format: 'pem',
      cert: text,
      key: clientCert?.key,
      passphrase: clientCert?.passphrase,
    });
    e.target.value = '';
  };

  const handlePemKeySelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await readFileAsText(file);
    setPemKeyFileName(file.name);
    setClientCert({
      format: 'pem',
      cert: clientCert?.cert,
      key: text,
      passphrase: clientCert?.passphrase,
    });
    e.target.value = '';
  };

  const handlePassphraseChange = (passphrase: string) => {
    const current = clientCert ?? { format: certFormat };
    setClientCert(passphrase ? { ...current, passphrase } : { ...current, passphrase: undefined });
  };

  const handleClearClientCert = () => {
    setClientCert(undefined);
    setPfxFileName('');
    setPemCertFileName('');
    setPemKeyFileName('');
    if (pfxInputRef.current) pfxInputRef.current.value = '';
    if (pemCertInputRef.current) pemCertInputRef.current.value = '';
    if (pemKeyInputRef.current) pemKeyInputRef.current.value = '';
  };

  // ── Format switch ─────────────────────────────────────────────────────────

  const switchFormat = (fmt: 'pfx' | 'pem') => {
    setCertFormat(fmt);
    // Clear the existing cert when switching format to avoid stale data
    handleClearClientCert();
  };

  // ── CA cert handlers ──────────────────────────────────────────────────────

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
  const hasClientCert =
    clientCert &&
    (clientCert.format === 'pfx' ? !!clientCert.pfx : !!(clientCert.cert || clientCert.key));

  return (
    <div className="space-y-6">
      {/* ── Section A: Client Certificate ─────────────────────────────── */}
      <div className="space-y-4">
        <SectionHeader>Client Certificate (mTLS)</SectionHeader>

        {/* Format selector */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => switchFormat('pfx')}
            className={`px-3 py-1 rounded text-xs font-mono border transition-colors ${
              certFormat === 'pfx'
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'text-muted-foreground border-border hover:text-foreground'
            }`}
          >
            PFX / P12
          </button>
          <button
            type="button"
            onClick={() => switchFormat('pem')}
            className={`px-3 py-1 rounded text-xs font-mono border transition-colors ${
              certFormat === 'pem'
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'text-muted-foreground border-border hover:text-foreground'
            }`}
          >
            PEM
          </button>
        </div>

        {certFormat === 'pfx' ? (
          <div className="space-y-3">
            {/* PFX file upload */}
            <div className="space-y-1.5">
              <Label className="text-xs font-mono">Certificate File (.p12 / .pfx)</Label>
              <div className="flex items-center gap-2">
                <input
                  ref={pfxInputRef}
                  type="file"
                  accept=".p12,.pfx"
                  onChange={handlePfxSelect}
                  className="hidden"
                  id="pfx-upload"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="font-mono text-xs"
                  onClick={() => pfxInputRef.current?.click()}
                >
                  Choose File
                </Button>
                {pfxFileName || clientCert?.pfx ? (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {pfxFileName || '(loaded)'}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">No file chosen</span>
                )}
              </div>
            </div>

            {/* Passphrase */}
            <div className="space-y-1.5">
              <Label htmlFor="pfx-passphrase" className="text-xs font-mono">
                Passphrase (optional)
              </Label>
              <Input
                id="pfx-passphrase"
                type="password"
                value={clientCert?.passphrase ?? ''}
                onChange={(e) => handlePassphraseChange(e.target.value)}
                placeholder="Certificate passphrase"
                className="h-8 text-xs font-mono bg-background border-border w-64"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* PEM certificate file */}
            <div className="space-y-1.5">
              <Label className="text-xs font-mono">Certificate (.pem / .crt)</Label>
              <div className="flex items-center gap-2">
                <input
                  ref={pemCertInputRef}
                  type="file"
                  accept=".pem,.crt"
                  onChange={handlePemCertSelect}
                  className="hidden"
                  id="pem-cert-upload"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="font-mono text-xs"
                  onClick={() => pemCertInputRef.current?.click()}
                >
                  Choose File
                </Button>
                {pemCertFileName || clientCert?.cert ? (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {pemCertFileName || '(loaded)'}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">No file chosen</span>
                )}
              </div>
            </div>

            {/* PEM private key file */}
            <div className="space-y-1.5">
              <Label className="text-xs font-mono">Private Key (.pem / .key)</Label>
              <div className="flex items-center gap-2">
                <input
                  ref={pemKeyInputRef}
                  type="file"
                  accept=".pem,.key"
                  onChange={handlePemKeySelect}
                  className="hidden"
                  id="pem-key-upload"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="font-mono text-xs"
                  onClick={() => pemKeyInputRef.current?.click()}
                >
                  Choose File
                </Button>
                {pemKeyFileName || clientCert?.key ? (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {pemKeyFileName || '(loaded)'}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">No file chosen</span>
                )}
              </div>
            </div>

            {/* Passphrase */}
            <div className="space-y-1.5">
              <Label htmlFor="pem-passphrase" className="text-xs font-mono">
                Passphrase (optional)
              </Label>
              <Input
                id="pem-passphrase"
                type="password"
                value={clientCert?.passphrase ?? ''}
                onChange={(e) => handlePassphraseChange(e.target.value)}
                placeholder="Key passphrase"
                className="h-8 text-xs font-mono bg-background border-border w-64"
              />
            </div>
          </div>
        )}

        {/* Clear button */}
        {hasClientCert && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="font-mono text-xs gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={handleClearClientCert}
          >
            <X className="h-3 w-3" />
            Clear Certificate
          </Button>
        )}

        {/* Desktop-only note */}
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

        {/* CA file upload */}
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

        {/* Paste area */}
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

        {/* Clear CA cert */}
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

        {/* Warning note */}
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
