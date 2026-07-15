import type { AgentTool } from './runner';
import type { ToolSource } from './types';

export interface AgentToolSourceAdapter {
  readonly kind: ToolSource['kind'];
  resolve(source: ToolSource): Promise<AgentTool[]>;
}

export interface AgentToolResolver {
  assertSupported(sources: ToolSource[]): void;
  resolve(sources: ToolSource[]): Promise<AgentTool[]>;
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
    const unsupported = sources.find((source) => !adaptersByKind.has(source.kind));
    if (unsupported) {
      throw new Error(`${unsupported.kind} tool sources need their runtime adapter configured`);
    }
  };

  return {
    assertSupported,
    async resolve(sources) {
      assertSupported(sources);
      const tools: AgentTool[] = [];
      for (const source of sources) {
        tools.push(...(await adaptersByKind.get(source.kind)!.resolve(source)));
      }
      return tools;
    },
  };
}
