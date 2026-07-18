import { lazyComponent } from '@/lib/shared/lazyComponent';

export const GitDialog = lazyComponent(() => import('@/components/shared/GitDialog'));
export const WorkflowBuilder = lazyComponent(async () => {
  const module = await import('@/features/workflows/components/WorkflowBuilder');
  return { default: module.WorkflowBuilder };
});
export const WorkflowExecutor = lazyComponent(async () => {
  const module = await import('@/features/workflows/components/WorkflowExecutor');
  return { default: module.WorkflowExecutor };
});
export const WorkflowManager = lazyComponent(async () => {
  const module = await import('@/features/workflows/components/WorkflowManager');
  return { default: module.WorkflowManager };
});
export const CollectionRunnerDialog = lazyComponent(async () => {
  const module = await import('./CollectionRunnerDialog');
  return { default: module.CollectionRunnerDialog };
});
export const CollectionSettingsDialog = lazyComponent(async () => {
  const module = await import('./CollectionSettingsDialog');
  return { default: module.CollectionSettingsDialog };
});
export const ExportSecretsDialog = lazyComponent(async () => {
  const module = await import('./ExportSecretsDialog');
  return { default: module.ExportSecretsDialog };
});
export const DocsViewer = lazyComponent(() => import('./DocsViewer'));
