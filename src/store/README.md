# Store organization

- `src/store/`: cross-cutting state used by multiple features
  (`useCollectionStore`, `useEnvironmentStore`, `useSettingsStore`,
  `useHistoryStore`, `useRequestStore`, `useConsoleStore`,
  `useWorkflowStore`, `useFileCollectionStore`, `useGraphQLSchemaStore`,
  `useProtoRegistryStore`).
- `src/features/<x>/store/`: protocol- or feature-specific state
  (`useCookieStore` under http, `useWebSocketStore` under websocket,
  `useSseStore` under sse, `useMcpStore` under mcp).

When adding a new persisted store, ask: "is this used outside the
feature folder?" If yes → `src/store/`. If no → feature-local.
