import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import SecretInput from '../SecretInput';
import type { AuthEditorProps } from './types';

export function OAuth1AuthEditor({ auth, onChange }: AuthEditorProps) {
  const oauth1 = auth.oauth1;
  const signatureMethod = oauth1?.signatureMethod ?? 'HMAC-SHA1';
  const withOAuth1 = (change: NonNullable<typeof oauth1>) => onChange({ ...auth, oauth1: change });
  const base = () => oauth1 ?? { consumerKey: '', consumerSecret: '' };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="auth-oauth1-consumer-key" className="text-sm font-medium mb-2 block">
          Consumer Key
        </label>
        <Input
          id="auth-oauth1-consumer-key"
          value={oauth1?.consumerKey ?? ''}
          onChange={(event) => withOAuth1({ ...base(), consumerKey: event.target.value })}
          placeholder="Enter consumer key"
          className="font-mono bg-background border-border"
        />
      </div>
      <div>
        <label htmlFor="auth-oauth1-consumer-secret" className="text-sm font-medium mb-2 block">
          Consumer Secret
        </label>
        <SecretInput
          id="auth-oauth1-consumer-secret"
          value={oauth1?.consumerSecret}
          onChange={(consumerSecret) => withOAuth1({ ...base(), consumerSecret })}
          placeholder="Enter consumer secret"
          storageLabel="oauth1.consumerSecret"
        />
      </div>
      <div>
        <label htmlFor="auth-oauth1-access-token" className="text-sm font-medium mb-2 block">
          Access Token (optional)
        </label>
        <SecretInput
          id="auth-oauth1-access-token"
          value={oauth1?.accessToken}
          onChange={(accessToken) => withOAuth1({ ...base(), accessToken })}
          placeholder="Enter access token"
          storageLabel="oauth1.accessToken"
        />
      </div>
      <div>
        <label htmlFor="auth-oauth1-access-token-secret" className="text-sm font-medium mb-2 block">
          Access Token Secret (optional)
        </label>
        <SecretInput
          id="auth-oauth1-access-token-secret"
          value={oauth1?.accessTokenSecret}
          onChange={(accessTokenSecret) => withOAuth1({ ...base(), accessTokenSecret })}
          placeholder="Enter access token secret"
          storageLabel="oauth1.accessTokenSecret"
        />
      </div>
      <div>
        <label htmlFor="auth-oauth1-signature-method" className="text-sm font-medium mb-2 block">
          Signature Method
        </label>
        <Select
          onValueChange={(value) =>
            withOAuth1({
              ...base(),
              signatureMethod: value as 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT',
            })
          }
          value={signatureMethod}
        >
          <SelectTrigger id="auth-oauth1-signature-method" className="bg-background border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="HMAC-SHA1">HMAC-SHA1</SelectItem>
            <SelectItem value="HMAC-SHA256">HMAC-SHA256</SelectItem>
            <SelectItem value="PLAINTEXT">PLAINTEXT</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label htmlFor="auth-oauth1-realm" className="text-sm font-medium mb-2 block">
          Realm (optional)
        </label>
        <Input
          id="auth-oauth1-realm"
          value={oauth1?.realm ?? ''}
          onChange={(event) => withOAuth1({ ...base(), realm: event.target.value })}
          placeholder="Enter realm"
          className="bg-background border-border"
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="oauth1-add-params-to-body"
          checked={oauth1?.addParamsToBody ?? false}
          onCheckedChange={(checked) =>
            withOAuth1({ ...base(), addParamsToBody: checked === true })
          }
        />
        <label htmlFor="oauth1-add-params-to-body" className="text-sm font-medium cursor-pointer">
          Include body params in signature (RFC 5849 §3.4.1.3.1)
        </label>
      </div>
    </div>
  );
}
