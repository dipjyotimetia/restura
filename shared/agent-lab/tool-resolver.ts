import type { AgentTool } from './runner';
import type { ToolSource } from './types';

export interface AgentToolSourceAdapter {
  readonly kind: ToolSource['kind'];
  assertSource?(source: ToolSource): void;
  resolve(source: ToolSource, signal?: AbortSignal): Promise<AgentTool[]>;
}

export interface AgentToolResolver {
  assertSupported(sources: ToolSource[]): void;
  resolve(sources: ToolSource[], signal?: AbortSignal): Promise<AgentTool[]>;
}

export function createAgentToolResolver(
  adapters: AgentToolSourceAdapter[] = []
): AgentToolResolver {
  const adaptersByKind = new Map<ToolSource['kind'], AgentToolSourceAdapter>();
  for (const adapter of adapters) {
    if (adaptersByKind.has(adapter.kind)) {
      throw new Error(`duplicate tool source adapter: ${adapter.kind}`);
    }
    adaptersByKind.set(adapter.kind, adapter);
  }

  const assertSupported = (sources: ToolSource[]): void => {
    for (const source of sources) {
      const adapter = adaptersByKind.get(source.kind);
      if (!adapter) {
        throw new Error(`${source.kind} tool sources need their runtime adapter configured`);
      }
      adapter.assertSource?.(source);
    }
  };

  return {
    assertSupported,
    async resolve(sources, signal) {
      assertSupported(sources);
      const tools: AgentTool[] = [];
      for (const source of sources) {
        signal?.throwIfAborted();
        tools.push(...(await adaptersByKind.get(source.kind)!.resolve(source, signal)));
      }
      return tools;
    },
  };
}
