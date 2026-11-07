import { beforeEach, describe, expect, it } from 'vitest';
import { useMockStore } from '@/store/useMockStore';

describe('useMockStore', () => {
  beforeEach(() => {
    useMockStore.setState({ status: { running: false }, routes: [] });
  });

  it('starts stopped with no routes', () => {
    expect(useMockStore.getState().status).toEqual({ running: false });
    expect(useMockStore.getState().routes).toEqual([]);
  });

  it('mirrors the server status and route summary', () => {
    useMockStore.getState().setStatus({ running: true, port: 4010 } as never);
    useMockStore.getState().setRoutes([{ method: 'GET', path: '/users' }]);
    expect(useMockStore.getState().status).toEqual({ running: true, port: 4010 });
    expect(useMockStore.getState().routes).toEqual([{ method: 'GET', path: '/users' }]);
  });
});
