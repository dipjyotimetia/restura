import { Input } from '@/components/ui/input';
import SecretInput from '../SecretInput';
import type { AuthEditorProps } from './types';

export function AwsSignatureAuthEditor({ auth, onChange }: AuthEditorProps) {
  const awsSignature = auth.awsSignature ?? {
    accessKey: '',
    secretKey: '',
    region: '',
    service: '',
  };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="auth-aws-access-key" className="text-sm font-medium mb-2 block">
          Access Key
        </label>
        <Input
          id="auth-aws-access-key"
          value={auth.awsSignature?.accessKey || ''}
          onChange={(event) =>
            onChange({ ...auth, awsSignature: { ...awsSignature, accessKey: event.target.value } })
          }
          placeholder="Enter AWS access key"
        />
      </div>
      <div>
        <label htmlFor="auth-aws-secret-key" className="text-sm font-medium mb-2 block">
          Secret Key
        </label>
        <SecretInput
          id="auth-aws-secret-key"
          value={auth.awsSignature?.secretKey}
          onChange={(secretKey) =>
            onChange({ ...auth, awsSignature: { ...awsSignature, secretKey } })
          }
          placeholder="Enter AWS secret key"
          storageLabel="awsSignature.secretKey"
        />
      </div>
      <div>
        <label htmlFor="auth-aws-region" className="text-sm font-medium mb-2 block">
          Region
        </label>
        <Input
          id="auth-aws-region"
          value={auth.awsSignature?.region || ''}
          onChange={(event) =>
            onChange({ ...auth, awsSignature: { ...awsSignature, region: event.target.value } })
          }
          placeholder="e.g., us-east-1"
        />
      </div>
      <div>
        <label htmlFor="auth-aws-service" className="text-sm font-medium mb-2 block">
          Service
        </label>
        <Input
          id="auth-aws-service"
          value={auth.awsSignature?.service || ''}
          onChange={(event) =>
            onChange({ ...auth, awsSignature: { ...awsSignature, service: event.target.value } })
          }
          placeholder="e.g., execute-api"
        />
      </div>
    </div>
  );
}
