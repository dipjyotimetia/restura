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

function appendParamsToUrl(url: string, params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return url;

  try {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      parsed.searchParams.append(key, value);
    }
    return parsed.toString();
  } catch {
    const joiner = url.includes('?') ? '&' : '?';
    return `${url}${joiner}${new URLSearchParams(params).toString()}`;
  }
}

/**
 * Intercepts the Worker's `/api/proxy` route (and, as a backstop, any direct
 * upstream call matching `upstreamPattern`) so tests see the user-visible
 * response regardless of transport. The renderer always POSTs the request spec
 * to `/api/proxy` on the web build; the spec carries `params` separately from
 * `url`, so we merge them here to mirror what the real Worker sends upstream
 * (see `shared/protocol/http-proxy.ts` / `e2e/real-http.spec.ts`).
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
      params?: Record<string, string>;
      data?: string;
    };
    const result = await handler({
      method: reqJson.method ?? 'GET',
      url: appendParamsToUrl(reqJson.url ?? '', reqJson.params),
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
