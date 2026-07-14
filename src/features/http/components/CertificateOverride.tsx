import { AlertTriangle, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import SecretInput from '@/features/auth/components/SecretInput';
import { readFileAsBase64, readFileAsText } from '@/lib/shared/file-utils';
import { looksLikePemCertificate, looksLikePemPrivateKey } from '@/lib/shared/pemValidation';
import { type SecretValue, unwrapSecret } from '@/lib/shared/secretRef';
import type { ClientCert } from '@/types';

interface CertificateOverrideProps {
  clientCert: ClientCert | undefined;
  onCertChange: (cert: ClientCert | undefined) => void;
}

export function CertificateOverride({ clientCert, onCertChange }: CertificateOverrideProps) {
  const [certFormat, setCertFormat] = useState<'pfx' | 'pem'>(clientCert?.format ?? 'pfx');
  const [pfxFileName, setPfxFileName] = useState('');
  const [pemCertFileName, setPemCertFileName] = useState('');
  const [pemKeyFileName, setPemKeyFileName] = useState('');
  const pfxRef = useRef<HTMLInputElement>(null);
  const pemCertRef = useRef<HTMLInputElement>(null);
  const pemKeyRef = useRef<HTMLInputElement>(null);

  const handlePfxSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const base64 = await readFileAsBase64(file);
    if (!base64) {
      toast.error('That file appears to be empty — choose a valid .p12 / .pfx bundle.');
      return;
    }
    setPfxFileName(file.name);
    onCertChange({
      format: 'pfx',
      pfx: base64,
      ...(clientCert?.passphrase !== undefined && { passphrase: clientCert.passphrase }),
    });
  };

  const handlePemCertSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await readFileAsText(file);
    if (!looksLikePemCertificate(text)) {
      toast.error('That file does not look like a PEM certificate (missing BEGIN CERTIFICATE).');
      return;
    }
    setPemCertFileName(file.name);
    onCertChange({
      format: 'pem',
      cert: text,
      ...(clientCert?.key !== undefined && { key: clientCert.key }),
      ...(clientCert?.passphrase !== undefined && { passphrase: clientCert.passphrase }),
    });
  };

  const handlePemKeySelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await readFileAsText(file);
    if (!looksLikePemPrivateKey(text)) {
      toast.error('That file does not look like a PEM private key (missing BEGIN PRIVATE KEY).');
      return;
    }
    setPemKeyFileName(file.name);
    onCertChange({
      format: 'pem',
      key: text,
      ...(clientCert?.cert !== undefined && { cert: clientCert.cert }),
      ...(clientCert?.passphrase !== undefined && { passphrase: clientCert.passphrase }),
    });
  };

  const handlePassphraseChange = (passphrase: SecretValue) => {
    const current = clientCert ?? { format: certFormat };
    // A handle resolves to the masked placeholder (non-empty), so it's kept;
    // only a genuinely empty inline value clears the passphrase.
    if (unwrapSecret(passphrase)) {
      onCertChange({ ...current, passphrase });
    } else {
      // Clear passphrase by omitting the key (EOPT-friendly)
      const { passphrase: _omit, ...rest } = current;
      void _omit;
      onCertChange(rest);
    }
  };

  const handleClearCert = () => {
    onCertChange(undefined);
    setPfxFileName('');
    setPemCertFileName('');
    setPemKeyFileName('');
  };

  const handleCertFormatSwitch = (fmt: 'pfx' | 'pem') => {
    setCertFormat(fmt);
    handleClearCert();
  };

  return (
    <div className="space-y-4 mt-2">
      {/* Format selector */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => handleCertFormatSwitch('pfx')}
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
          onClick={() => handleCertFormatSwitch('pem')}
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
          <div className="space-y-1.5">
            <Label className="text-xs font-mono">Certificate File (.p12 / .pfx)</Label>
            <div className="flex items-center gap-2">
              <input
                ref={pfxRef}
                type="file"
                accept=".p12,.pfx"
                onChange={handlePfxSelect}
                aria-label="Certificate file (.p12 / .pfx)"
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="font-mono text-xs"
                onClick={() => pfxRef.current?.click()}
              >
                Choose File
              </Button>
              <span className="text-xs text-muted-foreground truncate max-w-[180px]">
                {pfxFileName || (clientCert?.pfx ? '(loaded)' : 'No file chosen')}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="req-pfx-passphrase" className="text-xs font-mono">
              Passphrase (optional)
            </Label>
            <SecretInput
              value={clientCert?.passphrase}
              onChange={handlePassphraseChange}
              placeholder="Certificate passphrase"
              storageLabel="Client certificate passphrase"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-mono">Certificate (.pem / .crt)</Label>
            <div className="flex items-center gap-2">
              <input
                ref={pemCertRef}
                type="file"
                accept=".pem,.crt"
                onChange={handlePemCertSelect}
                aria-label="Certificate (.pem / .crt)"
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="font-mono text-xs"
                onClick={() => pemCertRef.current?.click()}
              >
                Choose File
              </Button>
              <span className="text-xs text-muted-foreground truncate max-w-[180px]">
                {pemCertFileName || (clientCert?.cert ? '(loaded)' : 'No file chosen')}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-mono">Private Key (.pem / .key)</Label>
            <div className="flex items-center gap-2">
              <input
                ref={pemKeyRef}
                type="file"
                accept=".pem,.key"
                onChange={handlePemKeySelect}
                aria-label="Private key (.pem / .key)"
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="font-mono text-xs"
                onClick={() => pemKeyRef.current?.click()}
              >
                Choose File
              </Button>
              <span className="text-xs text-muted-foreground truncate max-w-[180px]">
                {pemKeyFileName || (clientCert?.key ? '(loaded)' : 'No file chosen')}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="req-pem-passphrase" className="text-xs font-mono">
              Passphrase (optional)
            </Label>
            <SecretInput
              value={clientCert?.passphrase}
              onChange={handlePassphraseChange}
              placeholder="Key passphrase"
              storageLabel="Client certificate passphrase"
            />
          </div>
        </div>
      )}

      {certFormat === 'pem' && Boolean(clientCert?.cert) !== Boolean(clientCert?.key) && (
        <p className="text-xs text-amber-500 dark:text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" aria-hidden />
          <span>
            mTLS needs both a certificate and its private key. Until both are provided, this
            certificate won&rsquo;t be applied to requests.
          </span>
        </p>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="font-mono text-xs gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
        onClick={handleClearCert}
      >
        <X className="h-3 w-3" />
        Clear Certificate
      </Button>
    </div>
  );
}
