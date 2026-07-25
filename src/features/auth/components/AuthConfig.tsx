'use client';

import { ApiKeyAuthEditor } from './editors/ApiKeyAuthEditor';
import { AwsSignatureAuthEditor } from './editors/AwsSignatureAuthEditor';
import { BasicAuthEditor } from './editors/BasicAuthEditor';
import { BearerAuthEditor } from './editors/BearerAuthEditor';
import { DigestAuthEditor } from './editors/DigestAuthEditor';
import { NoAuthEditor } from './editors/NoAuthEditor';
import { NtlmAuthEditor } from './editors/NtlmAuthEditor';
import { OAuth1AuthEditor } from './editors/OAuth1AuthEditor';
import { OAuth2AuthEditor } from './editors/OAuth2AuthEditor';
import { WsseAuthEditor } from './editors/WsseAuthEditor';
import type { AuthEditorProps } from './editors/types';

/**
 * Renders only the request's own authentication configuration. Inheritance is
 * resolved at send time and intentionally remains the responsibility of
 * InheritedAuthHint/authInheritance rather than an editor concern.
 */
export default function AuthConfiguration(props: AuthEditorProps) {
  let editor: React.ReactNode;

  switch (props.auth.type) {
    case 'basic':
      editor = <BasicAuthEditor {...props} />;
      break;
    case 'bearer':
      editor = <BearerAuthEditor {...props} />;
      break;
    case 'api-key':
      editor = <ApiKeyAuthEditor {...props} />;
      break;
    case 'oauth2':
      editor = null;
      break;
    case 'digest':
      editor = <DigestAuthEditor {...props} />;
      break;
    case 'aws-signature':
      editor = <AwsSignatureAuthEditor {...props} />;
      break;
    case 'oauth1':
      editor = <OAuth1AuthEditor {...props} />;
      break;
    case 'ntlm':
      editor = <NtlmAuthEditor {...props} />;
      break;
    case 'wsse':
      editor = <WsseAuthEditor {...props} />;
      break;
    case 'none':
    default:
      editor = <NoAuthEditor />;
  }

  return (
    <div className="space-y-5">
      {editor}
      <OAuth2AuthEditor {...props} />
    </div>
  );
}
