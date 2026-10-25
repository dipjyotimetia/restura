// IPC channels: AI assistant and AI Lab.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const AI_IPC = {
  ai: {
    chat: 'ai:chat',
    chatCancel: 'ai:chat:cancel',
  },
  aiLab: {
    complete: 'ai-lab:complete',
    completeCancel: 'ai-lab:complete:cancel',
    stream: 'ai-lab:stream',
    streamCancel: 'ai-lab:stream:cancel',
    listModels: 'ai-lab:list-models',
    testConnection: 'ai-lab:test-connection',
    exportTelemetry: 'ai-lab:telemetry:export',
  },
} as const;

export const AI_EVENT_PREFIX = {
  ai: {
    chunk: 'ai:chat:chunk:',
    end: 'ai:chat:end:',
  },
  aiLab: {
    chunk: 'ai-lab:chunk:',
    end: 'ai-lab:end:',
  },
} as const;
