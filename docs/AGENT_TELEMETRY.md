# Agent telemetry

Agent telemetry is optional and disabled by default. It is available only for the Electron AI Lab and the `restura agent eval` CLI; the web app and Worker do not export agent telemetry.

Restura exports only allowlisted metadata: suite/task/agent identifiers, timing, model/provider names, token and cost totals, tool names/outcomes, and aggregate evaluation state. It never exports prompts, model responses, tool arguments or output, URLs, request bodies, headers, credentials, or error text.

The desktop AI Lab stores Langfuse and OTLP credentials as SecretRef handles. They are resolved only in Electron main. The telemetry panel accepts HTTPS destinations and local loopback HTTP collectors; endpoints with query strings, fragments, or embedded credentials are rejected.

For CI, pass `--telemetry-config telemetry.json`. Credentials must be environment references, never inline values:

```json
{
  "enabled": true,
  "target": "langfuse",
  "baseUrl": "https://cloud.langfuse.com",
  "publicKey": { "source": "env", "name": "LANGFUSE_PUBLIC_KEY" },
  "secretKey": { "source": "env", "name": "LANGFUSE_SECRET_KEY" },
  "environment": "ci",
  "sampleRate": 1
}
```

Langfuse uses its native OpenTelemetry processor. Generic collectors use the OpenTelemetry OTLP/HTTP exporter. Telemetry delivery is best-effort: a failed export is reported locally but never changes an agent suite's pass/fail exit code.
