import { test, expect, type HarnessIpc } from './fixtures';

// The SSRF guard must hold in the SHIPPED app, not just in unit tests: drive a
// real HTTP request at the cloud-metadata address and a private IP through the
// live IPC path and confirm the main process refuses to fetch them. No network
// dependency — the request is blocked before any socket opens.
test.describe('SSRF guard (live IPC)', () => {
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/']) {
    test(`http.request to ${url} is rejected`, async ({ window }) => {
      const outcome = await window.evaluate(async (target) => {
        const http = (window as unknown as { electron: HarnessIpc }).electron.http;
        try {
          const res = await http.request({ method: 'GET', url: target });
          return { blocked: false, status: res?.status as number | undefined };
        } catch (err) {
          return { blocked: true, error: err instanceof Error ? err.message : String(err) };
        }
      }, url);

      // Must be blocked by the SSRF guard — NOT merely fail because nothing is
      // listening at that address (CI has no server there). Asserting the guard's
      // own rejection message discriminates "guard ran" from "network was down":
      // a connection timeout/refusal would not match this pattern, so the spec
      // fails if the guard is ever removed.
      expect(outcome.blocked).toBe(true);
      expect(outcome.error ?? '').toMatch(
        /not allowed|blocked|private|internal|metadata|ssrf|security|reserved/i
      );
    });
  }
});
