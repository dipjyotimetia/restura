import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiLabStore } from '../../store/useAiLabStore';
import { useAiLabUiStore } from '../../store/useAiLabUiStore';
import AiLabWorkspace from '../AiLabWorkspace';

vi.mock('@/lib/shared/platform', () => ({ isElectron: () => true, getPlatform: () => 'darwin' }));
vi.mock('../Playground', () => ({ Playground: () => <div>Playground view</div> }));
vi.mock('../DatasetEditor', () => ({ DatasetEditor: () => <div>Datasets view</div> }));
vi.mock('../EvalBuilder', () => ({ EvalBuilder: () => <div>Evals view</div> }));
vi.mock('../Arena', () => ({ Arena: () => <div>Arena view</div> }));
vi.mock('../ReportView', () => ({ ReportView: () => <div>Reports view</div> }));
vi.mock('../ProviderManager', () => ({ ProviderManager: () => <div>Models view</div> }));

describe('AiLabWorkspace', () => {
  beforeEach(() => {
    useAiLabStore.setState({
      providers: {},
      prompts: {},
      datasets: {},
      evalConfigs: {},
      favoriteModelKeys: [],
      recentModelKeys: [],
    });
    useAiLabUiStore.setState({ tab: 'playground' });
  });

  it('uses persistent workspace navigation and exposes readiness at a glance', () => {
    render(
      <MemoryRouter>
        <AiLabWorkspace />
      </MemoryRouter>
    );

    expect(screen.getByRole('navigation', { name: 'AI Lab sections' })).toBeVisible();
    expect(screen.getByText('No providers')).toBeVisible();
    expect(screen.getByText('No models')).toBeVisible();
    expect(screen.getByText('No runs')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    expect(screen.getByText('Models view')).toBeVisible();
  });
});
