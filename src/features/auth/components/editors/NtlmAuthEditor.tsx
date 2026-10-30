import { Input } from '@/components/ui/input';
import { isCapableHere } from '@/lib/shared/capabilities';
import { isElectron } from '@/lib/shared/platform';
import SecretInput from '../SecretInput';
import type { AuthEditorProps } from './types';
import { UnappliedAuthNotice } from './UnappliedAuthNotice';

// The NTLM handshake needs a pinned connection only the desktop fetcher has (#1069).
const NTLM_WEB_MESSAGE =
  'NTLM is desktop-only — on web and self-host the request is sent without authentication. Credentials below are saved but only used by the desktop app.';

export function NtlmAuthEditor({ auth, onChange }: AuthEditorProps) {
  const ntlm = auth.ntlm;
  const applied = isCapableHere('http.auth.ntlm', isElectron());
  const base = () => ntlm ?? { username: '', password: '' };

  return (
    <div className="space-y-4">
      {!applied && (
        <UnappliedAuthNotice message={NTLM_WEB_MESSAGE} testId="ntlm-unimplemented-warning" />
      )}
      <div>
        <label htmlFor="auth-ntlm-username" className="text-sm font-medium mb-2 block">
          Username
        </label>
        <Input
          id="auth-ntlm-username"
          value={ntlm?.username ?? ''}
          onChange={(event) =>
            onChange({ ...auth, ntlm: { ...base(), username: event.target.value } })
          }
          placeholder="Enter username"
          className="bg-background border-border"
        />
      </div>
      <div>
        <label htmlFor="auth-ntlm-password" className="text-sm font-medium mb-2 block">
          Password
        </label>
        <SecretInput
          id="auth-ntlm-password"
          value={ntlm?.password}
          onChange={(password) => onChange({ ...auth, ntlm: { ...base(), password } })}
          placeholder="Enter password"
          storageLabel="ntlm.password"
        />
      </div>
      <div>
        <label htmlFor="auth-ntlm-domain" className="text-sm font-medium mb-2 block">
          Domain (optional)
        </label>
        <Input
          id="auth-ntlm-domain"
          value={ntlm?.domain ?? ''}
          onChange={(event) =>
            onChange({ ...auth, ntlm: { ...base(), domain: event.target.value } })
          }
          placeholder="e.g., CORP"
          className="bg-background border-border"
        />
      </div>
      <div>
        <label htmlFor="auth-ntlm-workstation" className="text-sm font-medium mb-2 block">
          Workstation (optional)
        </label>
        <Input
          id="auth-ntlm-workstation"
          value={ntlm?.workstation ?? ''}
          onChange={(event) =>
            onChange({ ...auth, ntlm: { ...base(), workstation: event.target.value } })
          }
          placeholder="Workstation name"
          className="bg-background border-border"
        />
      </div>
    </div>
  );
}
