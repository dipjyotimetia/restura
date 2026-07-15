# AI Agent Bundles

Agent Bundles are portable, Git-native inputs for deterministic API-agent
regression tests. They use JSON so the current desktop suite editor can export
and validate them without a second parser.

```json
{
  "schemaVersion": 1,
  "id": "orders-regression",
  "name": "Orders regression",
  "suite": { "schemaVersion": 2, "...": "existing Agent Suite fields" },
  "fixtures": [
    {
      "id": "order-42",
      "tool": {
        "name": "orders_get",
        "description": "Read order 42",
        "inputSchema": { "type": "object", "additionalProperties": false }
      },
      "output": [{ "type": "json", "value": { "id": 42, "status": "paid" } }]
    }
  ],
  "baseline": { "minPassRate": 1, "maxLatencyMs": 500 }
}
```

Use `{ "kind": "fixture", "fixtureId": "order-42" }` in an agent's
`tools` list. Fixture tools are deterministic, read-only, and available in
both the Electron runtime and `restura agent eval`.

Run a bundle in CI:

```bash
restura agent eval path/to/orders.agent-bundle.json --output report.json
```

The command exits non-zero when the suite fails or a committed baseline gate
regresses. Full reports include the sanitized agent trace and bundle gate
results. Bundles reject `secret-handle` credentials; use environment credential
references instead. Live saved-request and MCP tools are intentionally rejected
by the CLI until their trusted adapters are wired end to end.
