/**
 * A configuration refusal discovered while resolving tools (after the model
 * would otherwise start running). The runner records ordinary resolve errors
 * as a failed trial (exit 1); this marks the ones that are invalid input and
 * must surface as exit 2 before any model call is billed.
 */
export class AgentPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentPreflightError';
  }
}
