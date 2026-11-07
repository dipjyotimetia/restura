import { render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/shared/GitDialog', () => ({ default: () => <div>git dialog</div> }));
vi.mock('@/features/workflows/components/WorkflowBuilder', () => ({
  WorkflowBuilder: () => <div>workflow builder</div>,
}));
vi.mock('@/features/workflows/components/WorkflowExecutor', () => ({
  WorkflowExecutor: () => <div>workflow executor</div>,
}));
vi.mock('@/features/workflows/components/WorkflowManager', () => ({
  WorkflowManager: () => <div>workflow manager</div>,
}));
vi.mock('../CollectionRunnerDialog', () => ({
  CollectionRunnerDialog: () => <div>collection runner</div>,
}));
vi.mock('../CollectionSettingsDialog', () => ({
  CollectionSettingsDialog: () => <div>collection settings</div>,
}));
vi.mock('../ExportSecretsDialog', () => ({
  ExportSecretsDialog: () => <div>export secrets</div>,
}));
vi.mock('../DocsViewer', () => ({ default: () => <div>docs viewer</div> }));

import {
  CollectionRunnerDialog,
  CollectionSettingsDialog,
  DocsViewer,
  ExportSecretsDialog,
  GitDialog,
  WorkflowBuilder,
  WorkflowExecutor,
  WorkflowManager,
} from '../sidebarLazyDialogs';

const dialogs = {
  GitDialog,
  WorkflowBuilder,
  WorkflowExecutor,
  WorkflowManager,
  CollectionRunnerDialog,
  CollectionSettingsDialog,
  ExportSecretsDialog,
  DocsViewer,
} as unknown as Record<string, ComponentType<Record<string, never>>>;

describe('sidebarLazyDialogs', () => {
  it.each([
    ['GitDialog', 'git dialog'],
    ['WorkflowBuilder', 'workflow builder'],
    ['WorkflowExecutor', 'workflow executor'],
    ['WorkflowManager', 'workflow manager'],
    ['CollectionRunnerDialog', 'collection runner'],
    ['CollectionSettingsDialog', 'collection settings'],
    ['ExportSecretsDialog', 'export secrets'],
    ['DocsViewer', 'docs viewer'],
  ] as const)('%s lazily loads its named or default export', async (name, text) => {
    const Component = dialogs[name]!;
    render(<Component />);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });
});
