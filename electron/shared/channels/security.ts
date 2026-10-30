// IPC channels: Secrets, vault, keychain and execution policy.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const SECURITY_IPC = {
  secret: {
    store: 'secret:store',
    delete: 'secret:delete',
    describe: 'secret:describe',
    list: 'secret:list',
    clear: 'secret:clear',
    copy: 'secret:copy',
  },
  externalSecrets: {
    list: 'external-secrets:list',
    create: 'external-secrets:create',
    update: 'external-secrets:update',
    delete: 'external-secrets:delete',
    clear: 'external-secrets:clear',
  },
  // pm.vault — user-named async key-value secret store, separate from
  // the UUID-keyed handle store above so the two namespaces can't collide.
  // Keys are user-controlled strings (validated by ipc-validators); values
  // are encrypted with safeStorage in the main process.
  vault: {
    get: 'vault:get',
    set: 'vault:set',
    unset: 'vault:unset',
    clear: 'vault:clear',
  },
  keychain: {
    status: 'keychain:status',
    rotate: 'keychain:rotate',
  },
  security: {
    setExecutionPolicy: 'security:setExecutionPolicy',
  },
} as const;
