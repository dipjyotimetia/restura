/**
 * Dedicated worker for timeline regex search. Runs off the main thread so a
 * pathological pattern can only burn this worker, which the runner
 * terminate()s once it overruns its budget. Loaded as a Vite `?worker`
 * chunk (same-origin — allowed by both the web and Electron `worker-src`).
 */
import { handleRegexMessage, type RegexRequest } from './timeline-regex';

const scope = self as unknown as {
  onmessage: ((event: { data: RegexRequest }) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  handleRegexMessage(event.data, (msg) => scope.postMessage(msg));
};
