import { Input } from '@/components/ui/input';
import SecretInput from '../SecretInput';
import type { AuthEditorProps } from './types';

export function BasicAuthEditor({ auth, onChange }: AuthEditorProps) {
  // Seed both fields so a partial entry remains schema-valid while it is edited.
  const basic = auth.basic ?? { username: '', password: '' };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="auth-basic-username" className="text-sm font-medium mb-2 block">
          Username
        </label>
        <Input
          id="auth-basic-username"
          value={auth.basic?.username || ''}
          onChange={(event) =>
            onChange({ ...auth, basic: { ...basic, username: event.target.value } })
          }
          placeholder="Enter username"
          className="bg-background border-border"
        />
      </div>
      <div>
        <label htmlFor="auth-basic-password" className="text-sm font-medium mb-2 block">
          Password
        </label>
        <SecretInput
          id="auth-basic-password"
          value={auth.basic?.password}
          onChange={(password) => onChange({ ...auth, basic: { ...basic, password } })}
          placeholder="Enter password"
          storageLabel="basic.password"
        />
      </div>
    </div>
  );
}
