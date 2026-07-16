# Electron layer

Every renderer-callable operation needs all of:

- a channel in `electron/shared/channels.ts`;
- a bounded Zod input schema and `createValidatedHandler` registration;
- rate limiting and `assertTrustedSender(event)`;
- DNS/broker preflight where the operation connects outward;
- owner cleanup for streams or long-lived connections;
- a preload bridge method;
- a matching `electron/types/electron-api.ts` declaration.

Resolve `SecretRef` handles only during wire signing in main. Never return
plaintext through IPC. Run `npm run electron:compile` after any bridge change.
