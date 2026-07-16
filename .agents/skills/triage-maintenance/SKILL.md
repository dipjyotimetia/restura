---
name: triage-maintenance
description: Triage Restura dependency, security, CI, and agent-harness maintenance using evidence from the repository and GitHub.
---

# Triage Restura maintenance

Scope the requested dependency, security, CI, and harness streams. Use current
GitHub run logs and alerts, not remembered status. Classify each item as false
positive, mechanical fix, or judgment call. Security changes touching
`shared/protocol`, DNS/broker guards, IPC validators, secret stores, signing, or
sandboxes require `restura-security-auditor` review. Every code change uses an
isolated branch and `ship-check`; never commit to `main`. Skill metrics are
local advisory data and must be skipped cleanly when absent.
