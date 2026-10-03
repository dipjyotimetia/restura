# Store organization

- `src/store/`: cross-cutting state used by multiple features
  (`useCollectionStore`, `useEnvironmentStore`, `useGlobalsStore`,
  `useSettingsStore`, `useHistoryStore`, `useRequestStore`, `useConsoleStore`,
  `useWorkflowStore`, `useFileCollectionStore`, `useGraphQLSchemaStore`,
  `useProtoRegistryStore`, `useCollectionRunStore`), plus small in-memory
  stores that are not persisted (`useLoadTestStore` — recent load-test runs,
  `useMockStore` — desktop mock-server status, `useUiStore` — transient
  cross-component UI state).
- `src/features/<x>/store/`: protocol- or feature-specific state
  (`useCookieStore` under http, `useWebSocketStore` under websocket,
  `useSocketIOStore` under socketio, `useSseStore` under sse, `useMcpStore`
  under mcp, `useKafkaStore` under kafka, `useMqttStore` under mqtt, and
  `useAiLabStore` / `useAiLabUiStore` / `useEvalRunStore` / `useArenaStore`
  under ai-lab). The AI assistant keeps its store in `src/features/ai/store.ts`.

When adding a new persisted store, ask: "is this used outside the
feature folder?" If yes → `src/store/`. If no → feature-local.
