// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createElectronMock, fakeWebContents } from './helpers/electron-mock';

vi.mock('electron', () => createElectronMock());

import { webContents } from 'electron';
import { emitTo, errorMessage } from '../ipc-utils';

describe('emitTo', () => {
  beforeEach(() => vi.mocked(webContents.fromId).mockReset());

  it('sends to a live webContents', () => {
    const wc = fakeWebContents(11);
    vi.mocked(webContents.fromId).mockReturnValue(wc as never);

    emitTo(11, 'sse:event:c1', { data: 'hi' });

    expect(webContents.fromId).toHaveBeenCalledWith(11);
    expect(wc.send).toHaveBeenCalledWith('sse:event:c1', { data: 'hi' });
  });

  it('forwards multiple args', () => {
    const wc = fakeWebContents(1);
    vi.mocked(webContents.fromId).mockReturnValue(wc as never);
    emitTo(1, 'grpc:data:x', 'a', 'b', 'c');
    expect(wc.send).toHaveBeenCalledWith('grpc:data:x', 'a', 'b', 'c');
  });

  it('skips a destroyed webContents', () => {
    const wc = fakeWebContents(2);
    wc.isDestroyed.mockReturnValue(true);
    vi.mocked(webContents.fromId).mockReturnValue(wc as never);
    emitTo(2, 'ws:message:x', {});
    expect(wc.send).not.toHaveBeenCalled();
  });

  it('is a no-op when the webContents no longer exists', () => {
    vi.mocked(webContents.fromId).mockReturnValue(null as never);
    expect(() => emitTo(404, 'ws:close:x')).not.toThrow();
  });
});

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new Error('nope'))).toBe('nope');
  });
  it('stringifies non-Error values', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });
});
