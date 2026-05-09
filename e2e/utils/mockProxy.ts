import type { Page, Route } from '@playwright/test';

export interface MockProxyResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  time?: number;
  size?: number;
}

export type ProxyHandler = (req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}) => MockProxyResponse | Promise<MockProxyResponse>;

/**
 * Intercepts both Restura's worker proxy and direct upstream calls so tests
 * see the user-visible response regardless of which path the renderer takes
 * (Worker `/api/proxy` vs. direct axios when CORS proxy is off).
 */
export async function mockProxy(
  page: Page,
  handler: ProxyHandler,
  upstreamPattern: string | RegExp = /https:\/\/api\.example\.com\/.*/
): Promise<void> {
  await page.route('**/api/proxy', async (route: Route) => {
    const reqJson = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      data?: string;
    };
    const result = await handler({
      method: reqJson.method ?? 'GET',
      url: reqJson.url ?? '',
      headers: reqJson.headers ?? {},
      body: reqJson.data,
    });
    const data = {
      status: result.status ?? 200,
      statusText: result.statusText ?? 'OK',
      headers: result.headers ?? { 'content-type': 'application/json' },
      data: result.body ?? '{}',
      time: result.time ?? 42,
      size: result.size ?? (result.body ?? '{}').length,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
  });

  await page.route(upstreamPattern, async (route: Route) => {
    const req = route.request();
    const result = await handler({
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      body: req.postData() ?? undefined,
    });
    await route.fulfill({
      status: result.status ?? 200,
      headers: result.headers ?? { 'content-type': 'application/json' },
      body: result.body ?? '{}',
    });
  });
}
