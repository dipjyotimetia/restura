---
name: fix-until-green
description: Iterate on a Restura branch until a deterministic validation gate passes, with a hard attempt cap and root-cause-first fixes.
---

# Fix until green

Use the user-supplied gate, or `npm run validate` by default. Default to five
attempts.

For each attempt, run the gate, locate the first root cause at `file:line`, make
one coherent TDD fix, rerun the failed sub-gate, then rerun the full gate. Never
hand-edit generated OpenCollection or capability artifacts. If the same error
survives two consecutive attempts, stop with diagnosis rather than exhausting
the cap. Pause before a mechanical loop changes SSRF, IPC, secrets, signing, or
sandbox boundaries. On cap exhaustion report `NOT GREEN`, attempted fixes, and
remaining evidence.
