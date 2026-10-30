import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';

const platform = vi.hoisted(() => ({
  getElectronAPI: vi.fn(),
  isElectron: vi.fn(() => false),
}));

vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  ...platform,
}));

import ImportDialog from '../ImportDialog';

const POSTMAN_ENV = JSON.stringify({
  name: 'Prod env',
  values: [
    { key: 'apiBase', value: 'https://api.example.com', type: 'default' },
    { key: 'apiKey', value: 'sk-live-123', type: 'secret' },
  ],
  _postman_variable_scope: 'environment',
});

async function previewPostmanEnv() {
  const user = userEvent.setup();
  render(<ImportDialog open onOpenChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
  fireEvent.change(screen.getByLabelText('Paste import content'), {
    target: { value: POSTMAN_ENV },
  });
  await user.click(screen.getByRole('button', { name: /preview pasted postman/i }));
  return user;
}

function importedVar(key: string) {
  const envs = useEnvironmentStore.getState().environments;
  return envs.find((e) => e.name === 'Prod env')?.variables.find((v) => v.key === key);
}

describe('ImportDialog environment secrets (#1231)', () => {
  beforeEach(() => {
    useEnvironmentStore.setState({ environments: [] });
    platform.isElectron.mockReset();
  });

  it('web: drops secret values, lists the keys in the review and after confirm', async () => {
    platform.isElectron.mockReturnValue(false);
    const user = await previewPostmanEnv();

    const review = await screen.findByRole('region', { name: /import preview/i });
    expect(within(review).getByText(/apiKey/)).toBeInTheDocument();
    expect(review.textContent).not.toContain('sk-live-123');

    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(await screen.findByText(/Imported with 1 warning/i)).toBeInTheDocument();
    expect(screen.getByText(/re-enter it: apiKey/)).toBeInTheDocument();
    expect(importedVar('apiKey')).toMatchObject({ value: '', secret: true });
    expect(importedVar('apiBase')?.value).toBe('https://api.example.com');
  });

  it('drops when window.electron is absent (real platform detection)', async () => {
    const actual =
      await vi.importActual<typeof import('@/lib/shared/platform')>('@/lib/shared/platform');
    platform.isElectron.mockImplementation(actual.isElectron);
    expect((window as { electron?: unknown }).electron).toBeUndefined();
    await previewPostmanEnv();

    const review = await screen.findByRole('region', { name: /import preview/i });
    expect(within(review).getByText(/apiKey/)).toBeInTheDocument();
    expect(review.textContent).not.toContain('sk-live-123');
  });

  it('web: drops Hoppscotch secret values and lists the keys', async () => {
    platform.isElectron.mockReturnValue(false);
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /^Hoppscotch/ }));
    await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
    fireEvent.change(screen.getByLabelText('Paste import content'), {
      target: {
        value: JSON.stringify({
          v: 2,
          name: 'Prod env',
          variables: [
            { key: 'apiBase', initialValue: 'https://api.example.com', secret: false },
            { key: 'apiKey', currentValue: 'sk-live-123', secret: true },
          ],
        }),
      },
    });
    await user.click(screen.getByRole('button', { name: /preview pasted hoppscotch/i }));

    const review = await screen.findByRole('region', { name: /import preview/i });
    expect(within(review).getByText(/apiKey/)).toBeInTheDocument();
    expect(review.textContent).not.toContain('sk-live-123');
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(importedVar('apiKey')).toMatchObject({ value: '', secret: true });
  });

  // .bru `vars:secret` rows carry no value in Bruno's grammar, so this pins the
  // warning; value stripping is pinned in bruno-env-secrets.test.ts.
  it('web: warns with the key for Bruno environment secrets from a .zip import', async () => {
    platform.isElectron.mockReturnValue(false);
    const { zipEntries } = await import('@/lib/shared/zip-utils');
    const blob = await zipEntries([
      { relativePath: 'bruno.json', content: JSON.stringify({ name: 'Bru', version: '1' }) },
      {
        relativePath: 'environments/Prod env.bru',
        content: 'vars:secret [\n  apiKey\n]\n',
      },
    ]);
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} droppedFile={new File([blob], 'bru.zip')} />);
    await screen.findByRole('region', { name: /import preview/i });
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(await screen.findByText(/re-enter it: apiKey/)).toBeInTheDocument();
    expect(importedVar('apiKey')).toMatchObject({ value: '', secret: true });
  });

  it('desktop: keeps secret values and shows no drop warning', async () => {
    platform.isElectron.mockReturnValue(true);
    const user = await previewPostmanEnv();

    const review = await screen.findByRole('region', { name: /import preview/i });
    expect(within(review).queryByText(/apiKey/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(await screen.findByText(/Imported environment: Prod env/i)).toBeInTheDocument();
    expect(importedVar('apiKey')).toMatchObject({ value: 'sk-live-123', secret: true });
  });
});
