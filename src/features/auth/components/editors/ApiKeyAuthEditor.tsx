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

export function ApiKeyAuthEditor({ auth, onChange }: AuthEditorProps) {
  const apiKey = auth.apiKey ?? { key: '', value: '', in: 'header' as const };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="auth-apikey-key" className="text-sm font-medium mb-2 block">
          Key
        </label>
        <Input
          id="auth-apikey-key"
          value={auth.apiKey?.key || ''}
          onChange={(event) =>
            onChange({ ...auth, apiKey: { ...apiKey, key: event.target.value } })
          }
          placeholder="e.g., X-API-Key"
        />
      </div>
      <div>
        <label htmlFor="auth-apikey-value" className="text-sm font-medium mb-2 block">
          Value
        </label>
        <SecretInput
          id="auth-apikey-value"
          value={auth.apiKey?.value}
          onChange={(value) => onChange({ ...auth, apiKey: { ...apiKey, value } })}
          placeholder="Enter API key value"
          storageLabel="apiKey.value"
        />
      </div>
      <div>
        <label htmlFor="auth-apikey-in" className="text-sm font-medium mb-2 block">
          Add to
        </label>
        <Select
          value={auth.apiKey?.in || 'header'}
          onValueChange={(placement: 'header' | 'query') =>
            onChange({ ...auth, apiKey: { ...apiKey, in: placement } })
          }
        >
          <SelectTrigger id="auth-apikey-in">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="header">Header</SelectItem>
            <SelectItem value="query">Query Params</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
