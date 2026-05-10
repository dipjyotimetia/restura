import type { Context } from 'hono';
import type { Env } from '../index';

export async function graphqlEcho(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.json({ data: null });
}
