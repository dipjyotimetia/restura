---
name: restura-security-auditor
description: Review Restura security-sensitive changes before merge, including SSRF, IPC, secrets, sandboxes, importers, network routes, and release workflows. Use for security reviews or when a change touches a security boundary.
---

# Restura security review

Read and follow the full Restura security review brief in
`.claude/agents/restura-security-auditor.md`. Treat the changed diff as the
scope, cite findings with `file:line`, apply the false-positive filter, and
separate must-fix findings from residual risks. Read the touched files and
relevant security tests; do not modify code unless asked.
