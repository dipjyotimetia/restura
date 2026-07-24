# Task List: Production-grade React component remediation

## Phase 1: Correctness and test signal

- [x] Task 1: Make tab actions valid, independently keyboard-accessible controls.
  - Acceptance: save-back and close are sibling native buttons, can receive focus, activate with Enter/Space, and retain the existing mouse/context-menu behaviour.
  - Verify: `npx vitest run src/components/shared/__tests__/TabStrip.test.tsx src/components/shared/__tests__/accessibility.smoke.test.tsx`.
  - Files: `src/components/shared/TabBar.tsx`, `src/components/shared/__tests__/TabStrip.test.tsx`, `src/components/shared/__tests__/accessibility.smoke.test.tsx`.

- [x] Task 2: Remove React `act(...)` warnings from the affected shared-component tests.
  - Acceptance: stream, updater, and onboarding asynchronous state changes are awaited or scoped in `act`; the three suites emit no React warnings.
  - Verify: `npx vitest run src/components/shared/__tests__/StreamingResponseViewer.test.tsx src/components/shared/__tests__/UpdateNotification.test.tsx src/components/shared/__tests__/WelcomeOnboarding.test.tsx`.
  - Files: `src/components/shared/__tests__/StreamingResponseViewer.test.tsx`, `src/components/shared/__tests__/UpdateNotification.test.tsx`, `src/components/shared/__tests__/WelcomeOnboarding.test.tsx`.

## Phase 2: Shared and collection controllers

- [x] Task 3: Establish the settings feature shell and stable public contract.
  - Acceptance: `SectionId` and `SettingsDrawerProps` remain stable while the drawer shell, navigation, and section registry live under `src/features/settings/`.
  - Verify: focused SettingsDrawer tests and `npm run architecture:check`.
  - Files: `src/components/shared/SettingsDrawer.tsx`, `src/features/settings/SettingsDrawer.tsx`, `src/features/settings/types.ts`, `src/features/settings/components/SettingsNavigation.tsx`, `src/components/shared/__tests__/SettingsDrawer.test.tsx`.

- [x] Task 4: Extract general, appearance, request, and proxy settings sections.
  - Acceptance: each section owns its settings reads/writes and has no behavioural change; the legacy wrapper shrinks materially.
  - Verify: focused settings tests, `npm run type-check`, and `npm run architecture:check`.
  - Files: `src/features/settings/sections/GeneralSection.tsx`, `src/features/settings/sections/AppearanceSection.tsx`, `src/features/settings/sections/RequestsSection.tsx`, `src/features/settings/sections/ProxySection.tsx`, `src/features/settings/SettingsDrawer.tsx`.

- [x] Task 5: Extract security-oriented settings sections.
  - Acceptance: judge, certificate, security, and secret-handle flows retain platform gates and no plaintext secret crosses the renderer boundary.
  - Verify: focused settings tests, security-relevant tests, and `npm run architecture:check`.
  - Files: `src/features/settings/sections/JudgeSection.tsx`, `src/features/settings/sections/CertificatesSection.tsx`, `src/features/settings/sections/SecuritySection.tsx`, `src/features/settings/sections/SecretsSection.tsx`, `src/features/settings/SettingsDrawer.tsx`.

- [x] Task 6: Extract remaining settings sections and remove the SettingsDrawer exemption.
  - Acceptance: data, shortcuts, updates, and about sections are feature-owned; no settings component exceeds 800 lines; the React grandfathered entry is removed.
  - Verify: `npm run architecture:check`, focused settings tests, and `npm run build`.
  - Files: `src/features/settings/sections/DataSection.tsx`, `src/features/settings/sections/ShortcutsSection.tsx`, `src/features/settings/sections/UpdatesSection.tsx`, `src/features/settings/sections/AboutSection.tsx`, `scripts/architecture.config.mts`.

- [x] Task 7: Split collection sidebar commands and editing state from panel rendering.
  - Acceptance: creation, rename, import/export, Git, and destructive-action orchestration move into a focused hook or command module with unchanged store semantics.
  - Verify: collection/sidebar tests, `npm run type-check`, and `npm run architecture:check`.
  - Files: `src/features/collections/components/Sidebar.tsx`, `src/features/collections/hooks/useSidebarCommands.ts`, `src/features/collections/components/CollectionHeader.tsx`, `src/features/collections/components/CollectionActionsMenu.tsx`, `src/features/collections/components/__tests__/Sidebar.test.tsx`.

- [x] Task 8: Split collection sidebar panels and remove its size exemption.
  - Acceptance: collections, history, and workflows panels are focused components; keyboard/drag semantics are preserved; no collection sidebar source exceeds 800 lines.
  - Verify: collection tests, `npm run architecture:check`, and relevant web Playwright flow.
  - Files: `src/features/collections/components/CollectionsPanel.tsx`, `src/features/collections/components/HistoryPanel.tsx`, `src/features/collections/components/WorkflowsPanel.tsx`, `src/features/collections/components/Sidebar.tsx`, `scripts/architecture.config.mts`.

## Phase 3: Protocol controllers

- [x] Task 9: Separate Kafka connection/configuration state from the client view.
  - Acceptance: connection form, validation, and lifecycle actions have an explicit feature hook; desktop-only guards remain at the boundary.
  - Verify: Kafka unit tests, Electron Kafka tests, `npm run type-check:all`.
  - Files: `src/features/kafka/components/KafkaClient.tsx`, `src/features/kafka/hooks/useKafkaConnection.ts`, `src/features/kafka/components/KafkaConnectionForm.tsx`, `src/features/kafka/components/KafkaClient.test.tsx`.

- [x] Task 10: Extract Kafka consume/message and administration sections.
  - Acceptance: consumer list/detail and admin topic/group views are independently testable with stable selection and stream cleanup.
  - Verify: focused Kafka tests and Electron Playwright Kafka coverage where available.
  - Files: `src/features/kafka/components/KafkaConsumerPanel.tsx`, `src/features/kafka/components/KafkaMessageDetail.tsx`, `src/features/kafka/components/KafkaAdminPanel.tsx`, `src/features/kafka/components/KafkaClient.tsx`, `src/features/kafka/components/KafkaClient.test.tsx`.

- [x] Task 11: Remove the Kafka client size exemption.
  - Acceptance: `KafkaClient` is a compositional shell below 800 lines; extracted modules own their local props and no protocol behaviour is duplicated.
  - Verify: `npm run architecture:check`, Kafka unit/Electron tests, and `npm run build`.
  - Files: `src/features/kafka/components/KafkaClient.tsx`, `src/features/kafka/components/KafkaProducerPanel.tsx`, `src/features/kafka/components/KafkaTopicInspector.tsx`, `scripts/architecture.config.mts`.

- [x] Task 12: Decompose Network Console filtering, selection, and detail rendering.
  - Acceptance: filter/sort logic is pure or hook-owned, list rows remain virtualisation-friendly, and code-editor lazy loading remains unchanged.
  - Verify: Network Console tests, `npm run architecture:check`, and a web browser smoke test.
  - Files: `src/features/http/components/NetworkConsole/NetworkTab.tsx`, `src/features/http/components/NetworkConsole/useNetworkFilters.ts`, `src/features/http/components/NetworkConsole/NetworkEntryList.tsx`, `src/features/http/components/NetworkConsole/NetworkEntryDetail.tsx`, `scripts/architecture.config.mts`.

- [ ] Task 13: Decompose MCP discovery and invocation forms.
  - Acceptance: connection state, list views, schema flattening, and invoke forms have explicit boundaries; argument validation remains canonical and fully covered.
  - Verify: MCP component/lib tests, `npm run test:coverage`, and `npm run architecture:check`.
  - Files: `src/features/mcp/components/McpRequestBuilder.tsx`, `src/features/mcp/components/McpConnectionPanel.tsx`, `src/features/mcp/components/McpDiscoveryPanel.tsx`, `src/features/mcp/components/McpInvokeForm.tsx`, `scripts/architecture.config.mts`.

- [x] Task 14: Decompose MQTT configuration and message views.
  - Acceptance: connection controls, subscriptions, and message rows/details are independently testable; memoised message rendering and connection cleanup remain intact.
  - Verify: MQTT tests, Electron MQTT smoke coverage, and `npm run architecture:check`.
  - Files: `src/features/mqtt/components/MqttClient.tsx`, `src/features/mqtt/components/MqttConnectionPanel.tsx`, `src/features/mqtt/components/MqttSubscriptionsPanel.tsx`, `src/features/mqtt/components/MqttMessagePanel.tsx`, `scripts/architecture.config.mts`.

- [x] Task 15: Split auth scheme editors by domain and remove the AuthConfig exemption.
  - Acceptance: each authentication scheme is a focused editor; inherited-auth and SecretRef behaviour are preserved exactly.
  - Verify: `npx vitest run src/features/auth/components/__tests__/AuthConfig.test.tsx`, auth parity tests, and `npm run architecture:check`.
  - Files: `src/features/auth/components/AuthConfig.tsx`, `src/features/auth/components/editors/HttpAuthEditor.tsx`, `src/features/auth/components/editors/OAuthEditor.tsx`, `src/features/auth/components/editors/AdvancedAuthEditor.tsx`, `scripts/architecture.config.mts`.

## Phase 4: AI Lab and closeout

- [ ] Task 16: Split evaluation draft/run orchestration from scorer editing.
  - Acceptance: `EvalBuilder` composes focused draft, run-control, scorer, and live-result sections below the limit; cancellation semantics are unchanged.
  - Verify: EvalBuilder and agent-runtime tests, `npm run test:coverage`, `npm run architecture:check`.
  - Files: `src/features/ai-lab/components/EvalBuilder.tsx`, `src/features/ai-lab/components/EvalDraftEditor.tsx`, `src/features/ai-lab/components/EvalRunControls.tsx`, `src/features/ai-lab/components/ScorerEditor.tsx`, `scripts/architecture.config.mts`.

- [ ] Task 17: Split provider management into catalogue, credentials, and capability overrides.
  - Acceptance: provider keys remain SecretRef-safe, capability overrides remain explicit, and the UI retains its existing validation and desktop gating.
  - Verify: ProviderManager tests, secret-handling tests, and `npm run architecture:check`.
  - Files: `src/features/ai-lab/components/ProviderManager.tsx`, `src/features/ai-lab/components/ProviderCatalog.tsx`, `src/features/ai-lab/components/ProviderCredentialEditor.tsx`, `src/features/ai-lab/components/CapabilityOverrides.tsx`, `scripts/architecture.config.mts`.

- [ ] Task 18: Split evaluation report browsing, summary, and matrix/detail views.
  - Acceptance: report calculation helpers remain pure, selection and export behaviour are covered, and report components are below the cap.
  - Verify: ReportView tests, `npm run test:coverage`, and `npm run architecture:check`.
  - Files: `src/features/ai-lab/components/ReportView.tsx`, `src/features/ai-lab/components/ReportSummary.tsx`, `src/features/ai-lab/components/ReportRunList.tsx`, `src/features/ai-lab/components/ReportMatrix.tsx`, `scripts/architecture.config.mts`.

- [ ] Task 19: Review and proactively split the near-limit controller watchlist where a clear boundary exists.
  - Acceptance: EnvironmentManager, GrpcRequestBuilder, ResponseViewer, SocketIOClient, CommandPalette, CollectionTree, WebSocketClient, WorkflowCanvas, DatasetEditor, AgentWorkbench, and GraphQLRequestBuilder remain at or below 800 lines with no speculative micro-components.
  - Verify: `npm run architecture:check`, focused feature tests, and a fresh component review.
  - Files: one selected controller, up to three new feature-owned modules, its focused test file, and `scripts/architecture.config.mts` only if required.

- [ ] Task 20: Run final production verification and publish the evidence.
  - Acceptance: no React source is grandfathered, the full test run has no `act(...)` warnings, and the full gates pass without lowering quality thresholds.
  - Verify: `npm run validate`, `npm run test:e2e`, applicable `npm run test:e2e:electron`, and a fresh accessibility/architecture review.
  - Files: no production files expected; add only narrowly scoped regression tests or documentation if verification exposes a gap.
