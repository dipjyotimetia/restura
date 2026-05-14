import type { ProtocolRegistry, ProtocolModule } from './types';

export function createProtocolRegistry(): ProtocolRegistry {
  const modules = new Map<string, ProtocolModule>();
  return {
    register(m) {
      if (modules.has(m.id)) {
        throw new Error(`Protocol already registered: ${m.id}`);
      }
      modules.set(m.id, m);
    },
    get(id) {
      return modules.get(id);
    },
    list() {
      return Array.from(modules.values());
    },
  };
}

// Singleton for the running app. Bootstrap (Task 4.2) registers the
// known protocols against this instance.
export const protocolRegistry: ProtocolRegistry = createProtocolRegistry();
