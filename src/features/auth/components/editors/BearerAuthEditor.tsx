import SecretInput from '../SecretInput';
import type { AuthEditorProps } from './types';

export function BearerAuthEditor({ auth, onChange }: AuthEditorProps) {
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="auth-bearer-token" className="text-sm font-medium mb-2 block">
          Token
        </label>
        <SecretInput
          id="auth-bearer-token"
          value={auth.bearer?.token}
          onChange={(token) => onChange({ ...auth, bearer: { token } })}
          placeholder="Enter bearer token"
          storageLabel="bearer.token"
        />
      </div>
    </div>
  );
}
