// Opens the auth URL in a popup and waits for the redirect to contain a `code` param.
// This browser adapter stays outside the backend-agnostic OAuth protocol core.
export async function authorizeWithPopup(
  authUrl: string,
  expectedState: string,
  timeoutMs = 300_000
): Promise<{ code: string } | null> {
  return new Promise((resolve) => {
    const popup = window.open(authUrl, 'oauth2_popup', 'width=600,height=700');
    if (!popup) {
      resolve(null);
      return;
    }

    const deadline = Date.now() + timeoutMs;
    const check = setInterval(() => {
      try {
        if (popup.closed) {
          clearInterval(check);
          resolve(null);
          return;
        }
        const url = new URL(popup.location.href);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (code && state === expectedState) {
          clearInterval(check);
          popup.close();
          resolve({ code });
        }
      } catch {
        // Cross-origin — popup is still on the auth server; keep polling.
      }
      if (Date.now() > deadline) {
        clearInterval(check);
        popup.close();
        resolve(null);
      }
    }, 500);
  });
}
