import { Input } from '@/components/ui/input';
import SecretInput from '../SecretInput';
import { UnappliedAuthNotice } from './UnappliedAuthNotice';
import type { AuthEditorProps } from './types';

export function DigestAuthEditor({ auth, onChange }: AuthEditorProps) {
  return (
    <div className="space-y-4">
      <UnappliedAuthNotice scheme="Digest" />
      <div>
        <label htmlFor="auth-digest-username" className="text-sm font-medium mb-2 block">
          Username
        </label>
        <Input
          id="auth-digest-username"
          value={auth.digest?.username || ''}
          onChange={(event) =>
            onChange({ ...auth, digest: { ...auth.digest!, username: event.target.value } })
          }
          placeholder="Enter username"
        />
      </div>
      <div>
        <label htmlFor="auth-digest-password" className="text-sm font-medium mb-2 block">
          Password
        </label>
        <SecretInput
          id="auth-digest-password"
          value={auth.digest?.password}
          onChange={(password) => onChange({ ...auth, digest: { ...auth.digest!, password } })}
          placeholder="Enter password"
          storageLabel="digest.password"
        />
      </div>
    </div>
  );
}
