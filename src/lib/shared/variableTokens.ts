/**
 * Renderer entry to the core `{{var}}` grammar (`shared/variables/tokens`), for
 * the inline-text highlighter (`VariableText`) and the Monaco decoration scanner
 * (`CodeEditor`), so "gate", "highlight", "decorate" and what actually gets sent
 * can never disagree on what counts as a variable.
 */
export {
  hasVariableToken,
  scanVariableTokens as findVariableTokens,
  type VariableToken,
} from '@shared/variables/tokens';
