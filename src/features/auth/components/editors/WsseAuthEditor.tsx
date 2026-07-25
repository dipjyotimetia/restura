import { AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import SecretInput from '../SecretInput';
import type { AuthEditorProps } from './types';

export function WsseAuthEditor({ auth, onChange }: AuthEditorProps) {
  const wsse = auth.wsse;
  const passwordType = wsse?.passwordType ?? 'PasswordDigest';
  const base = () => wsse ?? { username: '', password: '' };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="auth-wsse-username" className="text-sm font-medium mb-2 block">
          Username
        </label>
        <Input
          id="auth-wsse-username"
          value={wsse?.username ?? ''}
          onChange={(event) =>
            onChange({ ...auth, wsse: { ...base(), username: event.target.value } })
          }
          placeholder="Enter username"
          className="bg-background border-border"
        />
      </div>
      <div>
        <label htmlFor="auth-wsse-password" className="text-sm font-medium mb-2 block">
          Password
        </label>
        <SecretInput
          id="auth-wsse-password"
          value={wsse?.password}
          onChange={(password) => onChange({ ...auth, wsse: { ...base(), password } })}
          placeholder="Enter password"
          storageLabel="wsse.password"
        />
      </div>
      <div>
        <label htmlFor="auth-wsse-password-type" className="text-sm font-medium mb-2 block">
          Password Type
        </label>
        <Select
          value={passwordType}
          onValueChange={(value) =>
            onChange({
              ...auth,
              wsse: { ...base(), passwordType: value as 'PasswordDigest' | 'PasswordText' },
            })
          }
        >
          <SelectTrigger id="auth-wsse-password-type" className="bg-background border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="PasswordDigest">PasswordDigest (recommended)</SelectItem>
            <SelectItem value="PasswordText">PasswordText (clear)</SelectItem>
          </SelectContent>
        </Select>
        {passwordType === 'PasswordText' && (
          <p
            className="text-xs text-amber-500 flex items-center gap-1 mt-2"
            data-testid="wsse-password-text-warning"
          >
            <AlertTriangle className="h-3 w-3" />
            PasswordText sends the password in the clear over the wire. Prefer PasswordDigest.
          </p>
        )}
      </div>
    </div>
  );
}
