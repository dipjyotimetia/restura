// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockIsRegisteredCollectionDirectory = vi.hoisted(() => vi.fn());
const mockList = vi.hoisted(() => vi.fn());
const mockLoad = vi.hoisted(() => vi.fn());
const mockSave = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ ipcMain: { handle: mockHandle } }));
vi.mock('../storage/collection-manager', () => ({
  isRegisteredCollectionDirectory: mockIsRegisteredCollectionDirectory,
}));
vi.mock('@shared/ows/node/workspace', () => ({
  listOwsWorkflowArtifactIds: mockList,
  loadOwsWorkflowArtifact: mockLoad,
  saveOwsWorkflowArtifact: mockSave,
  deleteOwsWorkflowArtifact: mockDelete,
}));

import { registerOwsWorkspaceHandlerIPC } from '../handlers/ows-workspace-handler';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<Record<string, unknown>>;

function trustedEvent() {
  return { senderFrame: { url: 'file:///app/dist/web/index.html', parent: null } };
}

function handlers(): Map<string, IpcHandler> {
  return new Map(
    mockHandle.mock.calls.map(([channel, handler]) => [channel as string, handler as IpcHandler])
  );
}

describe('OWS workspace IPC handler', () => {
  beforeEach(() => {
    mockHandle.mockClear();
    mockIsRegisteredCollectionDirectory.mockReset();
    mockList.mockReset();
    mockLoad.mockReset();
    mockSave.mockReset();
    mockDelete.mockReset();
    registerOwsWorkspaceHandlerIPC();
  });

  it('registers the list, load, and save channels', () => {
    expect([...handlers().keys()].sort()).toEqual([
      'ows-workspace:delete',
      'ows-workspace:list',
      'ows-workspace:load',
      'ows-workspace:save',
    ]);
  });

  it('refuses an unregistered root without touching workspace files', async () => {
    mockIsRegisteredCollectionDirectory.mockReturnValue(false);

    await expect(
      handlers().get('ows-workspace:list')!(trustedEvent(), { directoryPath: '/unregistered' })
    ).resolves.toEqual({ ok: false, error: 'Access denied: collection root is not registered.' });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('lists, loads, and saves only through the registered collection root', async () => {
    mockIsRegisteredCollectionDirectory.mockReturnValue(true);
    mockList.mockResolvedValue(['billing']);
    mockLoad.mockResolvedValue({
      workflow: {
        document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
        do: [],
      },
      bindings: { version: 1, tasks: {} },
      layout: { version: 1, nodes: {} },
    });
    const payload = {
      directoryPath: '/registered',
      workflowId: 'billing',
      workflow: {
        document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
        do: [],
      },
      bindings: { version: 1, tasks: {} },
      layout: { version: 1, nodes: {} },
    };

    await expect(
      handlers().get('ows-workspace:list')!(trustedEvent(), { directoryPath: '/registered' })
    ).resolves.toEqual({
      ok: true,
      workflowIds: ['billing'],
    });
    await expect(
      handlers().get('ows-workspace:load')!(trustedEvent(), {
        directoryPath: payload.directoryPath,
        workflowId: payload.workflowId,
      })
    ).resolves.toEqual({
      ok: true,
      artifact: {
        workflow: {
          document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
          do: [],
        },
        bindings: { version: 1, tasks: {} },
        layout: { version: 1, nodes: {} },
      },
    });
    await expect(handlers().get('ows-workspace:save')!(trustedEvent(), payload)).resolves.toEqual({
      ok: true,
    });
    await expect(
      handlers().get('ows-workspace:delete')!(trustedEvent(), {
        directoryPath: payload.directoryPath,
        workflowId: payload.workflowId,
      })
    ).resolves.toEqual({ ok: true });

    expect(mockList).toHaveBeenCalledWith('/registered');
    expect(mockLoad).toHaveBeenCalledWith('/registered', 'billing');
    expect(mockSave).toHaveBeenCalledWith(
      '/registered',
      'billing',
      payload.workflow,
      payload.bindings,
      payload.layout
    );
    expect(mockDelete).toHaveBeenCalledWith('/registered', 'billing');
  });

  it('rejects malformed IPC input before accessing a registered root', async () => {
    mockIsRegisteredCollectionDirectory.mockReturnValue(true);

    await expect(
      handlers().get('ows-workspace:load')!(trustedEvent(), {
        directoryPath: '/registered',
        workflowId: '../escape',
      })
    ).rejects.toThrow('Invalid IPC payload');
    await expect(
      handlers().get('ows-workspace:load')!(trustedEvent(), {
        directoryPath: '/registered',
        workflowId: 'con',
      })
    ).rejects.toThrow('Invalid IPC payload');
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
