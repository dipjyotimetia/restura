/**
 * Renderer entry to the core `{{var}}` grammar (`shared/variables/tokens`), for
 * the inline-text highlighter (`VariableText`) and the Monaco decoration scanner
 * (`CodeEditor`), so "gate", "highlight", "decorate" and what actually gets sent
 * can never disagree on what counts as a variable.
 */
import { isPlainVariableName } from '@shared/variables/tokens';

export {
  hasVariableToken,
  isPlainVariableName,
  scanVariableTokens as findVariableTokens,
  type VariableToken,
} from '@shared/variables/tokens';

/**
 * How a token shows in the UI. A known variable is known whatever its name; an
 * unknown one is flagged only if its name reads as a variable, otherwise it is
 * plain text. With no classifier, only names that read as variables are tokens.
 */
export function tokenDisplayStatus(
  name: string,
  getStatus?: (name: string) => 'resolved' | 'unresolved'
): 'resolved' | 'unresolved' | 'plain' {
  const status = getStatus?.(name);
  if (status === 'resolved') return status;
  if (!isPlainVariableName(name)) return 'plain';
  return status ?? 'resolved';
}
