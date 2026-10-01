import { resolveEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { resolveInheritedAuthFor } from '@/features/auth/lib/resolveInheritedAuthFor';
import { type CodeGeneratorType, codeGenerators } from '@/lib/shared/codeGenerators';
import {
  FORM_DATA_LANGUAGES,
  prepareCodegen,
  withNotes,
} from '@/lib/shared/codeGenerators/prepare';
import type { VariableDetail } from '@/lib/shared/variableScopes';
import type { HttpRequest, RequestSettings } from '@/types';

/**
 * Code snippet for a request: variables from every scope, effective
 * (inherited) auth, secrets masked unless asked otherwise, and comment notes
 * for anything the snippet can't reproduce.
 */
export function generateRequestCode(
  request: HttpRequest,
  language: CodeGeneratorType,
  options: { variables: VariableDetail[]; maskSecrets: boolean; settings?: RequestSettings }
): string {
  const values: Record<string, string> = {};
  const secretNames = new Set<string>();
  for (const v of options.variables) {
    if (v.value !== undefined) values[v.name] = v.value;
    if (v.secret) secretNames.add(v.name);
  }
  const inherited = resolveInheritedAuthFor(request);
  const prepared = prepareCodegen({
    request,
    auth: resolveEffectiveAuth(request.auth, inherited?.auth),
    values,
    secretNames,
    maskSecrets: options.maskSecrets,
  });
  const notes = [...prepared.notes];
  if (prepared.formData && !FORM_DATA_LANGUAGES.has(language)) {
    notes.push(
      'The multipart form-data body isn’t generated for this language; see the cURL snippet.'
    );
  }
  const code = codeGenerators[language].generate({
    ...prepared,
    ...(options.settings ? { settings: options.settings } : {}),
  });
  return withNotes(code, language, notes);
}
