import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OwsBindings, OwsLayout } from '../../bindings';
import type { OwsWorkflow } from '../../workflow-profile';
import {
  deleteOwsWorkflowArtifact,
  listOwsWorkflowArtifactIds,
  loadOwsWorkflowArtifact,
  saveOwsWorkflowArtifact,
} from '../workspace';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OWS workspace artifacts', () => {
  it('writes deterministic executable, binding, and layout files below workflows/<id>', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    roots.push(root);
    const bindings: OwsBindings = {
      version: 1,
      tasks: {},
    };
    const layout: OwsLayout = { version: 1, nodes: { '/do/0/seed': { x: 20, y: 40 } } };

    await saveOwsWorkflowArtifact(
      root,
      'billing',
      {
        document: {
          dsl: '1.0.3',
          namespace: 'restura',
          name: 'billing',
          version: '1.0.0',
        },
        do: [{ seed: { set: { source: 'workspace' } } }],
      },
      bindings,
      layout
    );

    expect(
      JSON.parse(await readFile(join(root, 'workflows/billing/workflow.ows.json'), 'utf8'))
    ).toMatchObject({
      document: { name: 'billing' },
    });
    await expect(loadOwsWorkflowArtifact(root, 'billing')).resolves.toMatchObject({
      bindings,
      layout,
    });
  });

  it('lists portable workflow artifacts in deterministic order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    roots.push(root);
    const workflow = (name: string): OwsWorkflow => ({
      document: { dsl: '1.0.3', namespace: 'restura', name, version: '1.0.0' },
      do: [{ seed: { set: { source: name } } }],
    });
    const bindings: OwsBindings = { version: 1, tasks: {} };
    const layout: OwsLayout = { version: 1, nodes: { '/do/0/seed': { x: 0, y: 0 } } };

    await saveOwsWorkflowArtifact(root, 'zulu', workflow('zulu'), bindings, layout);
    await saveOwsWorkflowArtifact(root, 'alpha', workflow('alpha'), bindings, layout);
    await mkdir(join(root, 'workflows/not_a_portable_id'));

    await expect(listOwsWorkflowArtifactIds(root)).resolves.toEqual(['alpha', 'zulu']);
  });

  it('rebuilds a missing presentation-only layout without changing the executable artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    roots.push(root);
    const workflow: OwsWorkflow = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
      do: [{ seed: { set: { source: 'workspace' } } }],
    };
    await saveOwsWorkflowArtifact(
      root,
      'billing',
      workflow,
      { version: 1, tasks: {} },
      { version: 1, nodes: { '/do/0/seed': { x: 1, y: 1 } } }
    );
    await rm(join(root, 'workflows/billing/layout.restura.json'));

    await expect(loadOwsWorkflowArtifact(root, 'billing')).resolves.toMatchObject({
      workflow,
      layout: { version: 1, nodes: {} },
    });
    await saveOwsWorkflowArtifact(
      root,
      'billing',
      workflow,
      { version: 1, tasks: {} },
      {
        version: 1,
        nodes: {},
      }
    );
    await expect(
      readFile(join(root, 'workflows/billing/layout.restura.json'), 'utf8')
    ).resolves.toContain('"version": 1');
  });

  it('rejects path traversal and a stale binding task path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    roots.push(root);
    const workflow: OwsWorkflow = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
      do: [{ seed: { set: { source: 'workspace' } } }],
    };

    await expect(
      saveOwsWorkflowArtifact(
        root,
        '../escape',
        workflow,
        { version: 1, tasks: {} },
        { version: 1, nodes: {} }
      )
    ).rejects.toThrow('workflow id');
    await expect(
      saveOwsWorkflowArtifact(
        root,
        'billing',
        workflow,
        {
          version: 1,
          tasks: {
            '/do/9/missing': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
          },
        },
        { version: 1, nodes: {} }
      )
    ).rejects.toThrow('does not exist');
    await expect(
      saveOwsWorkflowArtifact(
        root,
        'unbound-call',
        {
          ...workflow,
          document: { ...workflow.document, name: 'unbound-call' },
          do: [
            {
              request: {
                call: 'http',
                with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
              },
            },
          ],
        },
        { version: 1, tasks: {} },
        { version: 1, nodes: {} }
      )
    ).rejects.toThrow('missing an approved binding');
    await expect(
      saveOwsWorkflowArtifact(
        root,
        'Billing',
        workflow,
        { version: 1, tasks: {} },
        { version: 1, nodes: {} }
      )
    ).rejects.toThrow('portable lowercase identifier');
    await expect(
      saveOwsWorkflowArtifact(
        root,
        'con',
        workflow,
        { version: 1, tasks: {} },
        { version: 1, nodes: {} }
      )
    ).rejects.toThrow('portable lowercase identifier');
  });

  it('rejects a saved-request binding attached to a non-call task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    roots.push(root);
    const workflow: OwsWorkflow = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
      do: [{ pause: { wait: { milliseconds: 0 } } }],
    };

    await expect(
      saveOwsWorkflowArtifact(
        root,
        'billing',
        workflow,
        {
          version: 1,
          tasks: {
            '/do/0/pause': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
          },
        },
        { version: 1, nodes: {} }
      )
    ).rejects.toThrow('does not exist in the workflow document');
  });

  it('refuses an artifact directory that escapes through a symbolic link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    const outside = await mkdtemp(join(tmpdir(), 'restura-ows-outside-'));
    const aliases = await mkdtemp(join(tmpdir(), 'restura-ows-aliases-'));
    const rootAlias = join(aliases, 'workspace');
    roots.push(root, outside, aliases);
    await mkdir(join(root, 'workflows'));
    await symlink(outside, join(root, 'workflows/billing'));
    await symlink(outside, rootAlias);

    await expect(
      saveOwsWorkflowArtifact(
        root,
        'billing',
        {
          document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
          do: [{ seed: { set: { source: 'workspace' } } }],
        },
        { version: 1, tasks: {} },
        { version: 1, nodes: {} }
      )
    ).rejects.toThrow('symbolic link');
    await expect(loadOwsWorkflowArtifact(root, 'billing')).rejects.toThrow('symbolic link');
    await expect(
      saveOwsWorkflowArtifact(
        rootAlias,
        'billing',
        {
          document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
          do: [{ seed: { set: { source: 'workspace' } } }],
        },
        { version: 1, tasks: {} },
        { version: 1, nodes: {} }
      )
    ).rejects.toThrow('symbolic link');
  });

  it('serializes companion artifacts canonically regardless of input key order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    roots.push(root);
    const workflow: OwsWorkflow = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
      do: [{ first: { set: { source: 'one' } } }, { second: { set: { source: 'two' } } }],
    };
    const firstBindings = { tasks: {}, version: 1 } as OwsBindings;
    const firstLayout: OwsLayout = {
      version: 1,
      nodes: { '/do/1/second': { x: 2, y: 2 }, '/do/0/first': { x: 1, y: 1 } },
    };
    await saveOwsWorkflowArtifact(root, 'billing', workflow, firstBindings, firstLayout);
    const directory = join(root, 'workflows/billing');
    const before = await Promise.all([
      readFile(join(directory, 'bindings.restura.json'), 'utf8'),
      readFile(join(directory, 'layout.restura.json'), 'utf8'),
    ]);

    await saveOwsWorkflowArtifact(
      root,
      'billing',
      workflow,
      {
        version: 1,
        tasks: {},
      },
      { version: 1, nodes: { '/do/0/first': { x: 1, y: 1 }, '/do/1/second': { x: 2, y: 2 } } }
    );

    await expect(
      Promise.all([
        readFile(join(directory, 'bindings.restura.json'), 'utf8'),
        readFile(join(directory, 'layout.restura.json'), 'utf8'),
      ])
    ).resolves.toEqual(before);
  });

  it('serializes concurrent saves for the same artifact without leaving a mixed triplet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    roots.push(root);
    const artifact = (
      name: string
    ): {
      workflow: OwsWorkflow;
      bindings: OwsBindings;
      layout: OwsLayout;
    } => ({
      workflow: {
        document: { dsl: '1.0.3', namespace: 'restura', name, version: '1.0.0' },
        do: [{ request: { set: { name } } }],
      },
      bindings: { version: 1, tasks: {} },
      layout: { version: 1, nodes: { '/do/0/request': { x: name.length, y: 0 } } },
    });
    const first = artifact('first');
    const second = artifact('second');

    await expect(
      Promise.all([
        saveOwsWorkflowArtifact(root, 'billing', first.workflow, first.bindings, first.layout),
        saveOwsWorkflowArtifact(root, 'billing', second.workflow, second.bindings, second.layout),
      ])
    ).resolves.toEqual([undefined, undefined]);

    const saved = await loadOwsWorkflowArtifact(root, 'billing');
    const name = saved.workflow.document.name;
    expect(['first', 'second']).toContain(name);
    expect(saved.layout.nodes['/do/0/request']).toEqual({ x: name.length, y: 0 });
  });

  it('preserves existing artifacts when a destination child is not a regular file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    roots.push(root);
    const workflow: OwsWorkflow = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
      do: [{ seed: { set: { version: 1 } } }],
    };
    const bindings: OwsBindings = { version: 1, tasks: {} };
    const layout: OwsLayout = { version: 1, nodes: { '/do/0/seed': { x: 1, y: 1 } } };
    await saveOwsWorkflowArtifact(root, 'billing', workflow, bindings, layout);
    const directory = join(root, 'workflows/billing');
    const before = await Promise.all([
      readFile(join(directory, 'workflow.ows.json'), 'utf8'),
      readFile(join(directory, 'bindings.restura.json'), 'utf8'),
    ]);
    await rm(join(directory, 'layout.restura.json'));
    await mkdir(join(directory, 'layout.restura.json'));

    await expect(
      saveOwsWorkflowArtifact(
        root,
        'billing',
        { ...workflow, document: { ...workflow.document, version: '2.0.0' } },
        bindings,
        layout
      )
    ).rejects.toThrow('not a regular file');
    await expect(
      Promise.all([
        readFile(join(directory, 'workflow.ows.json'), 'utf8'),
        readFile(join(directory, 'bindings.restura.json'), 'utf8'),
      ])
    ).resolves.toEqual(before);
  });

  it('removes only a complete portable workflow artifact directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    roots.push(root);
    const workflow: OwsWorkflow = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
      do: [{ seed: { set: { value: true } } }],
    };
    await saveOwsWorkflowArtifact(
      root,
      'billing',
      workflow,
      { version: 1, tasks: {} },
      { version: 1, nodes: {} }
    );

    await expect(deleteOwsWorkflowArtifact(root, 'billing')).resolves.toBeUndefined();
    await expect(listOwsWorkflowArtifactIds(root)).resolves.toEqual([]);
    await expect(deleteOwsWorkflowArtifact(root, '../escape')).rejects.toThrow('workflow id');
  });

  it('fails closed for incomplete, unexpected, and malformed workspace artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'restura-ows-'));
    roots.push(root);
    const directory = join(root, 'workflows', 'billing');
    await mkdir(directory, { recursive: true });
    await expect(loadOwsWorkflowArtifact(root, 'billing')).rejects.toThrow();

    const workflow: OwsWorkflow = {
      document: { dsl: '1.0.3', namespace: 'restura', name: 'billing', version: '1.0.0' },
      do: [{ seed: { set: { value: true } } }],
    };
    await expect(
      saveOwsWorkflowArtifact(
        root,
        'billing',
        workflow,
        { version: 1, tasks: {} },
        { version: 1, nodes: {} }
      )
    ).rejects.toThrow('unsupported files');
    await rm(directory, { recursive: true });
    await saveOwsWorkflowArtifact(
      root,
      'billing',
      workflow,
      { version: 1, tasks: {} },
      {
        version: 1,
        nodes: {},
      }
    );
    await mkdir(join(directory, 'unexpected'));
    await expect(loadOwsWorkflowArtifact(root, 'billing')).rejects.toThrow('unsupported files');
  });
});
