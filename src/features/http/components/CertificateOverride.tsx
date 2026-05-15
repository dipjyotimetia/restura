import { useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import type { ClientCert } from '@/types';
import { readFileAsBase64, readFileAsText } from '@/lib/shared/file-utils';

interface CertificateOverrideProps {
  clientCert: ClientCert | undefined;
  onCertChange: (cert: ClientCert | undefined) => void;
}

export function CertificateOverride({ clientCert, onCertChange }: CertificateOverrideProps) {
  const [certFormat, setCertFormat] = useState<'pfx' | 'pem'>(
    clientCert?.format ?? 'pfx'
  );
  const [pfxFileName, setPfxFileName] = useState('');
  const [pemCertFileName, setPemCertFileName] = useState('');
  const [pemKeyFileName, setPemKeyFileName] = useState('');
  const pfxRef = useRef<HTMLInputElement>(null);
  const pemCertRef = useRef<HTMLInputElement>(null);
  const pemKeyRef = useRef<HTMLInputElement>(null);

  const handlePfxSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const base64 = await readFileAsBase64(file);
    setPfxFileName(file.name);
    onCertChange({
      format: 'pfx',
      pfx: base64,
      ...(clientCert?.passphrase !== undefined && { passphrase: clientCert.passphrase }),
    });
    e.target.value = '';
  };

  const handlePemCertSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await readFileAsText(file);
    setPemCertFileName(file.name);
    onCertChange({
      format: 'pem',
      cert: text,
      ...(clientCert?.key !== undefined && { key: clientCert.key }),
      ...(clientCert?.passphrase !== undefined && { passphrase: clientCert.passphrase }),
    });
    e.target.value = '';
  };

  const handlePemKeySelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await readFileAsText(file);
    setPemKeyFileName(file.name);
    onCertChange({
      format: 'pem',
      key: text,
      ...(clientCert?.cert !== undefined && { cert: clientCert.cert }),
      ...(clientCert?.passphrase !== undefined && { passphrase: clientCert.passphrase }),
    });
    e.target.value = '';
  };

  const handlePassphraseChange = (passphrase: string) => {
    const current = clientCert ?? { format: certFormat };
    if (passphrase) {
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
            <Input
              id="req-pfx-passphrase"
              type="password"
              value={clientCert?.passphrase ?? ''}
              onChange={(e) => handlePassphraseChange(e.target.value)}
              placeholder="Certificate passphrase"
              className="h-8 text-xs font-mono bg-background border-border w-56"
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
            <Input
              id="req-pem-passphrase"
              type="password"
              value={clientCert?.passphrase ?? ''}
              onChange={(e) => handlePassphraseChange(e.target.value)}
              placeholder="Key passphrase"
              className="h-8 text-xs font-mono bg-background border-border w-56"
            />
          </div>
        </div>
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
