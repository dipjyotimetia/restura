import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwsBindings, OwsLayout } from '@shared/ows/bindings';
import { saveOwsWorkflowArtifact } from '@shared/ows/node/workspace';
import type { OwsWorkflow } from '@shared/ows/workflow-profile';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverOwsWorkspace } from '../owsWorkspaceLoader';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const workflow: OwsWorkflow = {
  document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
  do: [{ seed: { set: { source: 'cli' } } }],
};

const bindings: OwsBindings = { version: 1, tasks: {} };
const layout: OwsLayout = { version: 1, nodes: { '/do/0/seed': { x: 0, y: 0 } } };

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'restura-ows-cli-'));
  roots.push(root);
  await writeFile(
    join(root, 'opencollection.yml'),
    'opencollection: "1.0.0"\ninfo:\n  name: OWS CLI\n  version: "1.0.0"\n'
  );
  return root;
}

describe('discoverOwsWorkspace', () => {
  it('discovers a validated OWS artifact from an OpenCollection workspace', async () => {
    const root = await createWorkspace();
    await saveOwsWorkflowArtifact(root, 'billing', workflow, bindings, layout);

    await expect(discoverOwsWorkspace(root)).resolves.toMatchObject({
      root,
      workflows: [
        {
          id: 'billing',
          artifact: {
            workflow: { document: { name: 'billing' } },
            bindings,
            layout,
          },
        },
      ],
    });
  });

  it('accepts an artifact with a removed presentation-only layout', async () => {
    const root = await createWorkspace();
    await saveOwsWorkflowArtifact(root, 'billing', workflow, bindings, layout);
    await rm(join(root, 'workflows', 'billing', 'layout.restura.json'));

    await expect(discoverOwsWorkspace(root)).resolves.toMatchObject({
      workflows: [
        {
          id: 'billing',
          artifact: {
            workflow: { document: { name: 'billing' } },
            layout: { version: 1, nodes: {} },
          },
        },
      ],
    });
  });

  it('rejects a workspace without the required OpenCollection root marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-cli-'));
    roots.push(root);
    await saveOwsWorkflowArtifact(root, 'billing', workflow, bindings, layout);

    await expect(discoverOwsWorkspace(root)).rejects.toThrow('opencollection.yml');
  });

  it('rejects a legacy workflow artifact rather than silently treating it as OWS', async () => {
    const root = await createWorkspace();
    await mkdir(join(root, 'workflows', 'legacy'), { recursive: true });
    await writeFile(join(root, 'workflows', 'legacy', 'workflow.json'), '{}');

    await expect(discoverOwsWorkspace(root)).rejects.toThrow('legacy or unsupported');
  });

  it('rejects non-HTTP bindings so discovery never advertises unsupported execution', async () => {
    const root = await createWorkspace();
    await saveOwsWorkflowArtifact(root, 'billing', workflow, bindings, layout);
    await writeFile(
      join(root, 'workflows', 'billing', 'bindings.restura.json'),
      JSON.stringify({
        version: 1,
        tasks: {
          '/do/0/seed': { kind: 'mcp-connection', call: 'mcp', resourceId: 'connection-1' },
        },
      })
    );

    await expect(discoverOwsWorkspace(root)).rejects.toThrow('Invalid OWS workspace artifacts');
  });

  it('rejects symbolic links in the workflow tree', async () => {
    const root = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'restura-ows-cli-outside-'));
    roots.push(outside);
    await mkdir(join(root, 'workflows'));
    await symlink(outside, join(root, 'workflows', 'billing'));

    await expect(discoverOwsWorkspace(root)).rejects.toThrow('symbolic link');
  });
});
