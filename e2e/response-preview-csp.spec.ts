import { expect, test } from './fixtures/app';
import { mockProxy } from './utils/mockProxy';
import { sendButton, setUrl } from './utils/selectors';

test.describe('HTML response preview CSP', () => {
  test('renders local markup without allowing outbound preview requests', async ({ app: page }) => {
    const outboundOrigin = 'https://response-preview.invalid';
    const outboundRequests: string[] = [];
    const outboundWebSockets: string[] = [];

    page.on('websocket', (socket) => {
      if (socket.url().startsWith('wss://response-preview.invalid')) {
        outboundWebSockets.push(socket.url());
      }
    });
    await page.route(`${outboundOrigin}/**`, async (route) => {
      outboundRequests.push(route.request().url());
      await route.abort();
    });

    await mockProxy(page, () => ({
      headers: { 'content-type': 'text/html' },
      body: `<!doctype html>
        <html>
          <head>
            <meta http-equiv="refresh" content="0;url=${outboundOrigin}/navigation">
            <style>
              @font-face { font-family: blocked; src: url("${outboundOrigin}/font.woff2"); }
              .remote-background { background-image: url("${outboundOrigin}/background.png"); }
            </style>
          </head>
          <body>
            <h1 style="color: rgb(0, 128, 0)">Rendered response</h1>
            <div class="remote-background">Local presentation</div>
            <img src="${outboundOrigin}/image.png" alt="blocked image">
            <audio src="${outboundOrigin}/audio.mp3" autoplay></audio>
            <video src="${outboundOrigin}/video.mp4" autoplay></video>
            <iframe src="${outboundOrigin}/nested-frame"></iframe>
            <script src="${outboundOrigin}/script.js"></script>
            <script>
              fetch("${outboundOrigin}/fetch");
              const xhr = new XMLHttpRequest();
              xhr.open("GET", "${outboundOrigin}/xhr");
              xhr.send();
              new WebSocket("wss://response-preview.invalid/socket");
            </script>
            <a href="${outboundOrigin}/link">External link</a>
            <form action="${outboundOrigin}/form" method="post">
              <button type="submit">Submit form</button>
            </form>
          </body>
        </html>`,
    }));

    await setUrl(page, 'https://api.example.com/html');
    await sendButton(page).click();
    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Preview' }).click();

    const preview = page.frameLocator('iframe[title="HTML Preview"]');
    await expect(preview.getByRole('heading', { name: 'Rendered response' })).toBeVisible();
    await expect(preview.getByText('Local presentation')).toBeVisible();

    await preview.getByRole('button', { name: 'Submit form' }).click();
    await preview.getByText('External link').click();
    await page.waitForTimeout(500);

    expect(outboundRequests).toEqual([]);
    expect(outboundWebSockets).toEqual([]);
    await expect(preview.getByRole('heading', { name: 'Rendered response' })).toBeVisible();
  });
});
