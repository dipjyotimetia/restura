import type { AuthConfig } from '@/types';

export interface AuthEditorProps {
  auth: AuthConfig;
  onChange: (auth: AuthConfig) => void;
}
