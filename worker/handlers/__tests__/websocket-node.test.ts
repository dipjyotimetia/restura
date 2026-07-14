// @vitest-environment node

import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createNodeWebsocketHandler } from '../websocket-node';
import { consumeTicket, wsTicket } from '../ws-ticket';

// `consumeTicket` is destructive (single-use). Pin the policy that
// `createNodeWebsocketHandler` does NOT call it eagerly at route-dispatch
// time — only inside `onOpen` once the WebSocket upgrade has succeeded.
// If a non-upgrade GET burned the ticket, the legitimate later upgrade
// would close with 1008.
describe('createNodeWebsocketHandler — ticket lifecycle (Fix #5)', () => {
  it('does not consume the ticket when createEvents runs (non-upgrade probe)', async () => {
    // Mint a real ticket via the wsTicket handler.
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const mintCtx: Context<any> = {
      req: {
        raw: new Request('http://x/api/ws-ticket', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'wss://echo.example/ws' }),
        }),
      },
      env: { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' },
      json: (data: unknown) =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    } as any;
    const mintRes = await wsTicket(mintCtx);
    const { ticket } = (await mintRes.json()) as { ticket: string };
    expect(typeof ticket).toBe('string');

    // Stub upgradeWebSocket so we can synchronously invoke createEvents and
    // confirm consumeTicket was NOT called. A real @hono/node-ws would only
    // run onOpen on an actual upgrade.
    const createEventsSeen = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const fakeUpgrade = (createEvents: (c: any) => unknown) =>
      (async (c: Context) => {
        createEventsSeen();
        // Invoke createEvents like @hono/node-ws does — but DO NOT then call onOpen.
        const events = createEvents(c);
        return events;
        // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
      }) as any;

    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const handler = createNodeWebsocketHandler(fakeUpgrade as any);

    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const probeCtx: Context<any> = {
      req: {
        query: (k: string) => (k === 'ticket' ? ticket : undefined),
      },
      env: { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' },
      // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    } as any;
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    await (handler as any)(probeCtx, () => undefined);
    expect(createEventsSeen).toHaveBeenCalled();

    // Ticket must still be valid — onOpen never ran, so consumeTicket must
    // not have been invoked at createEvents time.
    const stillValid = consumeTicket(ticket);
    expect(stillValid).not.toBeNull();
    expect(stillValid?.target).toBe('wss://echo.example/ws');
  });
});
