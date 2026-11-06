// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { assertTrustedSender, setDevServerOriginTrusted } from '../boundary';

function frameEvent(url: string) {
  return { senderFrame: { url, parent: null } } as unknown as Electron.IpcMainInvokeEvent;
}

const DEV_ORIGINS = ['http://localhost:5173/', 'http://127.0.0.1:5173/#/collections'];
const FILE_ENTRY = 'file:///Applications/Restura.app/Contents/Resources/dist/web/index.html';

describe('assertTrustedSender dev-server origin gate', () => {
  afterEach(() => setDevServerOriginTrusted(false));

  it('packaged (default) build rejects the Vite dev-server origin', () => {
    for (const url of DEV_ORIGINS) {
      expect(() => assertTrustedSender('test:channel', frameEvent(url))).toThrow(/untrusted frame/);
    }
  });

  it('dev mode accepts the Vite dev-server origin', () => {
    setDevServerOriginTrusted(true);
    for (const url of DEV_ORIGINS) {
      expect(() => assertTrustedSender('test:channel', frameEvent(url))).not.toThrow();
    }
    // Still only port 5173.
    expect(() => assertTrustedSender('test:channel', frameEvent('http://localhost:8080/'))).toThrow(
      /untrusted frame/
    );
  });

  it('accepts the pinned file:// renderer entry in both modes', () => {
    expect(() => assertTrustedSender('test:channel', frameEvent(FILE_ENTRY))).not.toThrow();
    setDevServerOriginTrusted(true);
    expect(() => assertTrustedSender('test:channel', frameEvent(FILE_ENTRY))).not.toThrow();
  });
});
