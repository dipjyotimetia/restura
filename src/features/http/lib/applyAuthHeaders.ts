import type { AuthConfig } from '@/types';
import { signRequest } from './awsSigV4';

export async function applyAuthHeaders(
  auth: AuthConfig,
  headers: Record<string, string>,
  url: string,
  method: string,
  body?: string
): Promise<Record<string, string>> {
  const result = { ...headers };

  switch (auth.type) {
    case 'bearer':
      if (auth.bearer?.token) {
        result['Authorization'] = `Bearer ${auth.bearer.token}`;
      }
      break;

    case 'basic':
      if (auth.basic?.username) {
        result['Authorization'] = `Basic ${btoa(`${auth.basic.username}:${auth.basic.password ?? ''}`)}`;
      }
      break;

    case 'api-key':
      if (auth.apiKey?.key && auth.apiKey?.value) {
        if (auth.apiKey.in === 'header') {
          result[auth.apiKey.key] = auth.apiKey.value;
        }
        // query-param injection is handled at URL-build time, not here
      }
      break;

    case 'oauth2':
      if (auth.oauth2?.accessToken) {
        result['Authorization'] = `${auth.oauth2.tokenType || 'Bearer'} ${auth.oauth2.accessToken}`;
      }
      break;

    case 'aws-signature':
      if (auth.awsSignature?.accessKey && auth.awsSignature?.secretKey && auth.awsSignature?.region && auth.awsSignature?.service) {
        const signed = await signRequest({
          accessKey: auth.awsSignature.accessKey,
          secretKey: auth.awsSignature.secretKey,
          region: auth.awsSignature.region,
          service: auth.awsSignature.service,
          url,
          method,
          headers: result,
          body,
        });
        result['Authorization'] = signed.Authorization;
        result['x-amz-date'] = signed['x-amz-date'];
        result['x-amz-content-sha256'] = signed['x-amz-content-sha256'];
      }
      break;

    case 'digest':
    case 'none':
    default:
      break;
  }

  return result;
}

export function applyApiKeyQueryParam(auth: AuthConfig, params: Record<string, string>): Record<string, string> {
  if (auth.type === 'api-key' && auth.apiKey?.key && auth.apiKey?.value && auth.apiKey.in === 'query') {
    return { ...params, [auth.apiKey.key]: auth.apiKey.value };
  }
  return params;
}
