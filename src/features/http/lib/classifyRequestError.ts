import type { Response } from '@/types';

export interface RequestErrorInfo {
  title: string;
  /** What to do next; omitted when we have no honest advice. */
  hint?: string | undefined;
  /** The original message, always shown so nothing is hidden behind the summary. */
  raw: string;
}

/**
 * Turns a transport-level failure into a summary + next step. Runs at render
 * time on the existing `Response` (no persisted field) so history, the
 * collection runner and the viewer all get it for free.
 *
 * Patterns match the strings the backends actually emit: the renderer validator
 * (`urlValidator.ts` / `shared/protocol/url-validation.ts`), the Worker/proxy
 * core (`shared/protocol/http-proxy.ts`), and the desktop DNS guard. Unknown
 * messages fall through to a generic title with the raw text — never a guess.
 *
 * Platform matters for advice: the Settings "Allow private IPs" toggle only
 * feeds the renderer validator. The hosted Worker's private-IP policy is an
 * env var (`ALLOW_PRIVATE_IPS`), so pointing web users at Settings would be wrong.
 */
export function classifyRequestError(
  response: Pick<Response, 'status' | 'statusText' | 'body'>,
  isDesktop: boolean
): RequestErrorInfo | null {
  const failed = response.status === 0 || response.statusText === 'Proxy Error';
  if (!failed) return null;

  const raw = response.body;
  const hit = (re: RegExp) => re.test(raw);

  if (hit(/Private\/internal IP addresses are not allowed/)) {
    return {
      title: 'Private or internal address blocked',
      raw,
      hint: isDesktop
        ? hit(/^Invalid URL:/)
          ? 'Blocked by the app’s network safety policy for this host.'
          : 'Enable “Allow private / internal IPs” in Settings → Security to reach internal hosts.'
        : 'The hosted web proxy can’t reach private networks. Use the desktop app, or self-host Restura with ALLOW_PRIVATE_IPS=true.',
    };
  }
  if (hit(/Cloud metadata endpoint is blocked/)) {
    return { title: 'Cloud metadata endpoint blocked', raw };
  }
  if (hit(/Localhost URLs are not allowed|Hostname "[^"]*" is blocked for security reasons/)) {
    return {
      title: 'Local or reserved host blocked',
      raw,
      hint: isDesktop
        ? undefined
        : 'Localhost isn’t reachable from the web app. Use the desktop app.',
    };
  }
  if (hit(/desktop-only|Secret handles are desktop-only/i)) {
    return {
      title: 'Needs the desktop app',
      raw,
      hint: 'This feature isn’t available in the web client.',
    };
  }
  if (hit(/timeout after \d+\s*ms/i)) {
    return {
      title: 'Request timed out',
      raw,
      hint: 'The server didn’t answer in time. Raise the timeout in the request’s Settings tab.',
    };
  }
  if (hit(/DNS lookup failed for/)) {
    return {
      title: 'Couldn’t resolve the host',
      raw,
      hint: 'Check the hostname for typos and your network connection.',
    };
  }
  if (!isDesktop && hit(/^Network Error$|Failed to fetch/i)) {
    return {
      title: 'Couldn’t reach the Restura proxy',
      raw,
      hint: 'The request never left the app. Check your connection and try again.',
    };
  }
  if (hit(/Response too large/)) {
    return { title: 'Response too large', raw };
  }
  return { title: 'Request failed', raw };
}
