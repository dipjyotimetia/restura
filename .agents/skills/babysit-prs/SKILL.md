---
name: babysit-prs
description: Monitor Restura pull requests, diagnose real CI logs, address scoped review feedback, and continue until every watched PR is merged or closed.
---

# Babysit Restura pull requests

For each user-scoped PR, check current merge state, conflicts, failing checks,
and unresolved review threads. Open the real failing GitHub Actions log before
editing and reproduce its exact gate locally. Apply only scoped, unambiguous
fixes, verify them, then push when publication is authorized. Surface ambiguous
architectural feedback instead of guessing. Never force-push, bypass hooks, or
change security boundaries without explicit approval. Report only changed PRs;
finish when every watched PR is merged or closed.
