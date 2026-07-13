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
      runReports: {},
    });
    useAiLabUiStore.setState({ tab: 'playground' });
  });

  it('includes agent run reports in run readiness and Reports counts', () => {
    useAiLabStore.setState({
      runReports: {
        agent: {
          id: 'agent',
          kind: 'agent-suite',
          name: 'Agent',
          startedAt: 1,
          finishedAt: 2,
          status: 'passed',
          suite: {
            schemaVersion: 2,
            id: 'suite',
            name: 'Suite',
            mode: 'regression',
            agents: [],
            tasks: [],
            graders: [],
            trials: 1,
          },
          payload: {
            suiteId: 'suite',
            status: 'passed',
            results: [],
            summary: {
              total: 0,
              passed: 0,
              failed: 0,
              errors: 0,
              cancelled: 0,
              passRate: 0,
              confidence95: { low: 0, high: 0 },
              passAtK: {},
              passToK: {},
              reliabilityByCase: [],
            },
          },
        },
      },
    });
    render(
      <MemoryRouter>
        <AiLabWorkspace />
      </MemoryRouter>
    );
    expect(screen.getByText('1 run')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reports' })).toHaveTextContent('1');
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
