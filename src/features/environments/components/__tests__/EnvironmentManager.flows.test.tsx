import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import type { Environment } from '@/types';
import EnvironmentManager from '../EnvironmentManager';

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const realRemove = useEnvironmentStore.getState().removeEnvironment;

function seed(environments: Environment[], activeEnvironmentId: string | null = null) {
  useEnvironmentStore.setState({ environments, activeEnvironmentId });
}

function names() {
  return useEnvironmentStore.getState().environments.map((e) => e.name);
}

function rail() {
  return screen.getByRole('navigation', { name: 'Environments' });
}

function renderManager() {
  return render(<EnvironmentManager open onOpenChange={() => {}} />);
}

beforeEach(() => {
  toastMock.error.mockReset();
  useEnvironmentStore.setState({ removeEnvironment: realRemove });
  useGlobalsStore.setState({ vars: {} });
  seed([]);
});

describe('EnvironmentManager empty state', () => {
  it('creates an environment from a scaffold and selects it', async () => {
    const user = userEvent.setup();
    renderManager();
    expect(screen.getByRole('heading', { name: 'No environments yet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /staging/i }));
    expect(names()).toEqual(['Staging']);
    expect(within(rail()).getByText('Staging').closest('[role="button"]')).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(screen.getByTitle('Click to rename')).toHaveTextContent('Staging');
  });

  it('creates a blank environment', async () => {
    const user = userEvent.setup();
    renderManager();
    await user.click(screen.getByRole('button', { name: /create blank environment/i }));
    expect(names()).toEqual(['New environment']);
  });

  it('opens globals and the scope inspector from the empty state', async () => {
    const user = userEvent.setup();
    renderManager();
    await user.click(screen.getByRole('button', { name: 'Edit globals' }));
    expect(screen.getByText('No globals yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^globals/i })).toHaveAttribute(
      'aria-current',
      'true'
    );
    // No footer while there are no environments.
    expect(screen.queryByRole('button', { name: /set as active/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /variables in scope/i }));
    expect(screen.getByText(/no variables in scope/i)).toBeInTheDocument();
  });
});

describe('EnvironmentManager selection sync', () => {
  it('opens the scope inspector straight from the empty state', async () => {
    const user = userEvent.setup();
    renderManager();
    await user.click(screen.getByRole('button', { name: 'Variables in scope' }));
    expect(screen.getByText(/no variables in scope/i)).toBeInTheDocument();
  });

  it('selects the first environment once one appears, and none once all are gone', () => {
    renderManager();
    act(() => seed([{ id: 'late', name: 'Late', variables: [] }]));
    expect(screen.getByTitle('Click to rename')).toHaveTextContent('Late');
    act(() => seed([]));
    expect(screen.getByRole('heading', { name: 'No environments yet' })).toBeInTheDocument();
  });
});

describe('EnvironmentManager rail', () => {
  it('shows host hints, variable/secret counts, sub-environments and the active badge', () => {
    seed(
      [
        {
          id: 'api',
          name: 'API',
          variables: [
            { id: 'v', key: 'baseUrl', value: 'https://api.example.com/v1', enabled: true },
          ],
        },
        {
          id: 'api-eu',
          name: 'API EU',
          parentId: 'api',
          variables: [
            { id: 'a', key: 'token', value: 'x', enabled: true, secret: true },
            { id: 'b', key: 'region', value: 'eu', enabled: true },
          ],
        },
        {
          id: 'one',
          name: 'One',
          variables: [{ id: 'c', key: 'flag', value: '1', enabled: true }],
        },
      ],
      'api'
    );
    renderManager();
    const rows = within(rail())
      .getAllByRole('button')
      .filter((b) => b.getAttribute('tabindex') === '0');
    // Sub-environments render directly under their base.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^APIActiveapi\.example\.com/),
      expect.stringMatching(/^API EUsub2 variables · 1 secret/),
      expect.stringMatching(/^One1 variable$/),
    ]);
    // Initial selection is the active environment.
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    // Header: counts + host; active pill; footer button reflects active.
    expect(screen.getByText('1 variable · api.example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Active' })).toBeDisabled();
  });

  it('selects rows by click and keyboard, and sets the selection active', async () => {
    const user = userEvent.setup();
    seed([
      { id: 'a', name: 'Alpha', variables: [] },
      { id: 'b', name: 'Beta', variables: [] },
    ]);
    renderManager();
    const beta = within(rail()).getByText('Beta').closest('[role="button"]') as HTMLElement;
    fireEvent.keyDown(beta, { key: 'Enter' });
    expect(beta).toHaveAttribute('aria-current', 'true');
    const alpha = within(rail()).getByText('Alpha').closest('[role="button"]') as HTMLElement;
    fireEvent.keyDown(alpha, { key: ' ' });
    expect(alpha).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(beta, { key: 'x' });
    expect(alpha).toHaveAttribute('aria-current', 'true');

    await user.click(beta);
    await user.click(screen.getByRole('button', { name: /set as active/i }));
    expect(useEnvironmentStore.getState().activeEnvironmentId).toBe('b');
    expect(screen.getByRole('button', { name: 'Active' })).toBeDisabled();
  });

  it('searches once there are four or more environments', async () => {
    const user = userEvent.setup();
    seed(
      ['Local', 'Staging', 'Prod', 'Perf'].map((name) => ({
        id: name.toLowerCase(),
        name,
        variables: [],
      }))
    );
    renderManager();
    const search = screen.getByRole('textbox', { name: 'Search environments' });
    await user.type(search, 'p');
    expect(within(rail()).queryByText('Local')).toBeNull();
    expect(within(rail()).getByText('Prod')).toBeInTheDocument();
    expect(within(rail()).getByText('Perf')).toBeInTheDocument();
    await user.type(search, 'zzz');
    expect(within(rail()).getByText('No matches')).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, '   ');
    expect(within(rail()).getByText('Local')).toBeInTheDocument();
  });

  it('hides search below four environments', () => {
    seed([{ id: 'a', name: 'Alpha', variables: [] }]);
    renderManager();
    expect(screen.queryByRole('textbox', { name: 'Search environments' })).toBeNull();
  });

  it('adds numbered environments and sub-environments of the selected base', async () => {
    const user = userEvent.setup();
    seed([{ id: 'base', name: 'Base', collectionId: 'col-1', variables: [] }]);
    renderManager();
    await user.click(screen.getByRole('button', { name: /new sub-environment/i }));
    const sub = useEnvironmentStore.getState().environments.find((e) => e.parentId === 'base');
    expect(sub).toMatchObject({ name: 'Base sub-environment', collectionId: 'col-1' });
    // A sub-environment is selected now, so the sub-env button is gone.
    expect(screen.queryByRole('button', { name: /new sub-environment/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /^new environment$/i }));
    expect(names()).toContain('Environment 3');
  });

  it('creates a sub-environment without a collection link when the base has none', async () => {
    const user = userEvent.setup();
    seed([
      {
        id: 'base',
        name: 'Base',
        variables: [{ id: 's', key: 'token', value: 'x', enabled: true, secret: true }],
      },
    ]);
    renderManager();
    // Rail row and detail header both summarise the singular counts.
    expect(screen.getAllByText('1 variable · 1 secret')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /new sub-environment/i }));
    const sub = useEnvironmentStore.getState().environments.find((e) => e.parentId === 'base');
    expect(sub?.name).toBe('Base sub-environment');
    expect(sub).not.toHaveProperty('collectionId');
  });

  it('switches the detail pane to globals and scope and back', async () => {
    const user = userEvent.setup();
    seed([{ id: 'a', name: 'Alpha', variables: [] }]);
    renderManager();
    await user.click(screen.getByRole('button', { name: /^globals/i }));
    expect(screen.getByText('No globals yet')).toBeInTheDocument();
    // The footer's "Set as active" only applies to the env view.
    expect(screen.queryByRole('button', { name: /set as active/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /variables in scope/i }));
    expect(screen.getByText(/no variables in scope/i)).toBeInTheDocument();
    await user.click(within(rail()).getByText('Alpha'));
    expect(screen.getByTitle('Click to rename')).toHaveTextContent('Alpha');
  });
});

describe('EnvironmentManager detail pane', () => {
  beforeEach(() => {
    seed([
      {
        id: 'a',
        name: 'Alpha',
        variables: [
          { id: 's1', key: 'k1', value: 'v', enabled: true, secret: true },
          { id: 's2', key: 'k2', value: 'v', enabled: true, secret: true },
        ],
      },
    ]);
  });

  it('pluralises secrets in the header', () => {
    renderManager();
    expect(screen.getByText('2 variables · 2 secrets')).toBeInTheDocument();
  });

  it('renames on Enter and on blur, ignores blank/unchanged names, and cancels on Escape', async () => {
    const user = userEvent.setup();
    renderManager();
    await user.click(screen.getByTitle('Click to rename'));
    let input = screen.getByRole('textbox', { name: 'Environment name' });
    await user.clear(input);
    await user.type(input, 'Gamma{Enter}');
    expect(names()).toEqual(['Gamma']);

    await user.click(screen.getByTitle('Click to rename'));
    input = screen.getByRole('textbox', { name: 'Environment name' });
    await user.clear(input);
    await user.type(input, 'Discarded{Escape}');
    expect(names()).toEqual(['Gamma']);
    expect(screen.getByTitle('Click to rename')).toHaveTextContent('Gamma');

    await user.click(screen.getByTitle('Click to rename'));
    input = screen.getByRole('textbox', { name: 'Environment name' });
    await user.clear(input);
    await user.type(input, '   ');
    fireEvent.blur(input);
    expect(names()).toEqual(['Gamma']);

    await user.click(screen.getByTitle('Click to rename'));
    input = screen.getByRole('textbox', { name: 'Environment name' });
    await user.clear(input);
    await user.type(input, 'Delta');
    fireEvent.blur(input);
    expect(names()).toEqual(['Delta']);
  });

  it('renames, duplicates and deletes from the actions menu', async () => {
    const user = userEvent.setup();
    renderManager();
    await user.click(screen.getByRole('button', { name: 'Environment actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    expect(await screen.findByRole('textbox', { name: 'Environment name' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Environment actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    expect(names()).toEqual(['Alpha', 'Alpha (copy)']);
    const copy = useEnvironmentStore.getState().environments[1]!;
    expect(copy.variables.map((v) => v.id)).not.toContain('s1');
    expect(screen.getByTitle('Click to rename')).toHaveTextContent('Alpha (copy)');

    await user.click(screen.getByRole('button', { name: 'Environment actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('"Alpha (copy)"');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(names()).toEqual(['Alpha']);
    // Selection falls back to the remaining environment.
    expect(screen.getByTitle('Click to rename')).toHaveTextContent('Alpha');
  });

  it('cancelling the delete confirm keeps the environment', async () => {
    const user = userEvent.setup();
    renderManager();
    await user.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' })
    );
    expect(names()).toEqual(['Alpha']);
  });

  it('reports a store refusal at confirm time', async () => {
    const user = userEvent.setup();
    const refuse = vi.fn(() => false);
    useEnvironmentStore.setState({ removeEnvironment: refuse });
    renderManager();
    await user.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );
    expect(refuse).toHaveBeenCalledWith('a');
    expect(toastMock.error).toHaveBeenCalledWith('Remove its sub-environments first.');
  });

  it('edits and deletes variables of the selected environment', async () => {
    const user = userEvent.setup();
    renderManager();
    const keys = screen.getAllByRole('textbox', { name: 'variable key' });
    await user.type(keys[0]!, 'X');
    expect(useEnvironmentStore.getState().environments[0]!.variables[0]!.key).toBe('k1X');
    await user.click(screen.getAllByRole('button', { name: 'Delete variable' })[1]!);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );
    expect(useEnvironmentStore.getState().environments[0]!.variables.map((v) => v.id)).toEqual([
      's1',
    ]);
  });

  it('adds a variable to the selected environment', async () => {
    const user = userEvent.setup();
    renderManager();
    await user.click(screen.getByRole('button', { name: /add variable/i }));
    const vars = useEnvironmentStore.getState().environments[0]!.variables;
    expect(vars).toHaveLength(3);
    expect(vars[2]).toMatchObject({ key: '', value: '', enabled: true });
  });
});
