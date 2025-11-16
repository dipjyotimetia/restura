'use client';

import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AuthConfig, AuthType } from '@/types';
import { Lock } from 'lucide-react';

interface AuthConfigProps {
  auth: AuthConfig;
  onChange: (auth: AuthConfig) => void;
}

export default function AuthConfiguration({ auth, onChange }: AuthConfigProps) {
  const handleTypeChange = (type: AuthType) => {
    onChange({ type });
  };

  const renderAuthFields = () => {
    switch (auth.type) {
      case 'basic':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Username</label>
              <Input
                value={auth.basic?.username || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    basic: { ...auth.basic!, username: e.target.value },
                  })
                }
                placeholder="Enter username"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Password</label>
              <Input
                type="password"
                value={auth.basic?.password || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    basic: { ...auth.basic!, password: e.target.value },
                  })
                }
                placeholder="Enter password"
              />
            </div>
          </div>
        );

      case 'bearer':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Token</label>
              <Input
                value={auth.bearer?.token || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    bearer: { token: e.target.value },
                  })
                }
                placeholder="Enter bearer token"
                className="font-mono"
              />
            </div>
          </div>
        );

      case 'api-key':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Key</label>
              <Input
                value={auth.apiKey?.key || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    apiKey: { ...auth.apiKey!, key: e.target.value },
                  })
                }
                placeholder="e.g., X-API-Key"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Value</label>
              <Input
                value={auth.apiKey?.value || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    apiKey: { ...auth.apiKey!, value: e.target.value },
                  })
                }
                placeholder="Enter API key value"
                className="font-mono"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Add to</label>
              <Select
                value={auth.apiKey?.in || 'header'}
                onValueChange={(value: 'header' | 'query') =>
                  onChange({
                    ...auth,
                    apiKey: { ...auth.apiKey!, in: value },
                  })
                }
              >
                <SelectTrigger>
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

      case 'oauth2':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Access Token</label>
              <Input
                value={auth.oauth2?.accessToken || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    oauth2: { accessToken: e.target.value },
                  })
                }
                placeholder="Enter access token"
                className="font-mono"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Token Type (optional)</label>
              <Input
                value={auth.oauth2?.tokenType || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    oauth2: { ...auth.oauth2!, tokenType: e.target.value },
                  })
                }
                placeholder="Bearer"
              />
            </div>
          </div>
        );

      case 'digest':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Username</label>
              <Input
                value={auth.digest?.username || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    digest: { ...auth.digest!, username: e.target.value },
                  })
                }
                placeholder="Enter username"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Password</label>
              <Input
                type="password"
                value={auth.digest?.password || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    digest: { ...auth.digest!, password: e.target.value },
                  })
                }
                placeholder="Enter password"
              />
            </div>
          </div>
        );

      case 'aws-signature':
        return (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Access Key</label>
              <Input
                value={auth.awsSignature?.accessKey || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...auth.awsSignature!, accessKey: e.target.value },
                  })
                }
                placeholder="Enter AWS access key"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Secret Key</label>
              <Input
                type="password"
                value={auth.awsSignature?.secretKey || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...auth.awsSignature!, secretKey: e.target.value },
                  })
                }
                placeholder="Enter AWS secret key"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Region</label>
              <Input
                value={auth.awsSignature?.region || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...auth.awsSignature!, region: e.target.value },
                  })
                }
                placeholder="e.g., us-east-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Service</label>
              <Input
                value={auth.awsSignature?.service || ''}
                onChange={(e) =>
                  onChange({
                    ...auth,
                    awsSignature: { ...auth.awsSignature!, service: e.target.value },
                  })
                }
                placeholder="e.g., execute-api"
              />
            </div>
          </div>
        );

      case 'none':
      default:
        return (
          <div className="text-center py-8 text-muted-foreground">
            <Lock className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>This request does not use any authentication.</p>
            <p className="text-sm mt-1">Select an auth type above to get started.</p>
          </div>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <label className="text-sm font-medium mb-2 block">Auth Type</label>
        <Select value={auth.type} onValueChange={(value) => handleTypeChange(value as AuthType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No Auth</SelectItem>
            <SelectItem value="basic">Basic Auth</SelectItem>
            <SelectItem value="bearer">Bearer Token</SelectItem>
            <SelectItem value="api-key">API Key</SelectItem>
            <SelectItem value="oauth2">OAuth 2.0</SelectItem>
            <SelectItem value="digest">Digest Auth</SelectItem>
            <SelectItem value="aws-signature">AWS Signature</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {renderAuthFields()}
    </div>
  );
}
