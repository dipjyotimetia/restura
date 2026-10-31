import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileAsText } from '@/lib/shared/file-utils';
import type { ClientCert } from '@/types';
import { CertificateOverride } from '../CertificateOverride';

vi.mock('@/lib/shared/file-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/file-utils')>()),
  readFileAsText: vi.fn(),
}));

const CERT = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';

function deferredRead() {
  let resolve: (text: string) => void = () => {};
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function Harness({ onChange }: { onChange: (cert: ClientCert | undefined) => void }) {
  const [cert, setCert] = useState<ClientCert | undefined>({ format: 'pem' });
  return (
    <CertificateOverride
      clientCert={cert}
      onCertChange={(next) => {
        setCert(next);
        onChange(next);
      }}
    />
  );
}

function input(accept: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`input[type="file"][accept="${accept}"]`);
  if (!el) throw new Error(`no file input for ${accept}`);
  return el;
}

function pick(accept: string, name: string): void {
  fireEvent.change(input(accept), { target: { files: [new File(['x'], name)] } });
}

describe('CertificateOverride overlapping file reads', () => {
  beforeEach(() => {
    vi.mocked(readFileAsText).mockReset();
  });

  it.each([
    ['the certificate read finishes first', 'cert', 'key'],
    ['the key read finishes first', 'key', 'cert'],
  ] as const)('keeps both PEM parts when %s', async (_label, first, second) => {
    const certRead = deferredRead();
    const keyRead = deferredRead();
    vi.mocked(readFileAsText)
      .mockReturnValueOnce(certRead.promise)
      .mockReturnValueOnce(keyRead.promise);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    // Both pickers fire before either read completes, so neither handler has
    // re-rendered with the other's result.
    pick('.pem,.crt', 'client.crt');
    pick('.pem,.key', 'client.key');
    const finish = { cert: () => certRead.resolve(CERT), key: () => keyRead.resolve(KEY) };
    await act(async () => {
      finish[first]();
      await Promise.resolve();
    });
    await act(async () => {
      finish[second]();
      await Promise.resolve();
    });

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenLastCalledWith({ format: 'pem', cert: CERT, key: KEY });
    expect(screen.getByText('client.crt')).toBeTruthy();
    expect(screen.getByText('client.key')).toBeTruthy();
  });

  it('does not bring a cleared certificate back when a read finishes afterwards', async () => {
    const keyRead = deferredRead();
    vi.mocked(readFileAsText).mockReturnValueOnce(keyRead.promise);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    pick('.pem,.key', 'client.key');
    fireEvent.click(screen.getByRole('button', { name: 'Clear Certificate' }));
    await act(async () => {
      keyRead.resolve(KEY);
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByText('client.key')).toBeNull();
  });
});
