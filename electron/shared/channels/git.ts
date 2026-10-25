// IPC channels: Git operations on collections.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const GIT_IPC = {
  git: {
    init: 'git:init',
    status: 'git:status',
    log: 'git:log',
    diff: 'git:diff',
    branchList: 'git:branch:list',
    add: 'git:add',
    unstage: 'git:unstage',
    discard: 'git:discard',
    commit: 'git:commit',
    createBranch: 'git:branch:create',
    checkoutBranch: 'git:branch:checkout',
    fetch: 'git:fetch',
    pull: 'git:pull',
    push: 'git:push',
    clone: 'git:clone',
    mergeState: 'git:merge:state',
    mergeStart: 'git:merge:start',
    mergeConflict: 'git:merge:conflict',
    mergeResolve: 'git:merge:resolve',
    mergeAbort: 'git:merge:abort',
    mergeComplete: 'git:merge:complete',
  },
} as const;
