# OWS Workflows

Restura Flow is an [Open Workflow Specification](https://openworkflowspec.org/) (OWS) feature. `workflow.ows.json` is the only executable workflow document; Restura does not import, convert, retain, or execute its former linear or proprietary graph formats.

## Workspace artifacts

An OpenCollection workspace may contain portable workflows alongside its saved requests:

```text
opencollection.yml
workflows/<workflow-id>/workflow.ows.json
workflows/<workflow-id>/bindings.restura.json
workflows/<workflow-id>/layout.restura.json
```

- `workflow.ows.json` is normalized, validated, graphed, and serialized by `@openworkflowspec/sdk` in the Node workspace and CLI boundary. The renderer retains Electron's strict CSP and uses the same bounded profile without loading the SDK's dynamic code generator.
- `bindings.restura.json` maps an OWS task path to an approved saved-request reference. It contains no URLs, headers, credentials, environment values, scripts, or executable behavior.
- `layout.restura.json` is editor-only presentation metadata. It may be removed; Restura loads an empty layout and recreates it on the next save, without changing execution.

Saved-request references use a percent-encoded OpenCollection logical path, such as `Users/Get%20user`. A rename or deletion makes the binding stale and execution fails closed.

## Executable profile

The editor imports native OWS JSON or YAML, then normalizes it to canonical OWS JSON. Persistence and export use JSON only. Restura currently executes the bounded profile below:

- `do`, `set`, and `wait` tasks.
- A task or workflow timeout, including cancellation propagation.
- HTTP `call` tasks that use `restura://saved-request` and an approved `{ kind: "saved-request", call: "http" }` binding.

The OWS task never supplies a real endpoint, headers, body, authentication, or transport. At run time, Restura resolves the bound saved request and sends it through the same HTTP protocol adapter, inherited authentication, SSRF policy, header policy, secret resolution, timeout, and cancellation boundary as a normal request.

Restura currently rejects controls and transports without a complete safe runtime: `fork`, `for`, `switch`, `try`, event tasks, `run`, OpenAPI, AsyncAPI, MCP, A2A, inline authentication/secrets, schedules, opaque extensions, and arbitrary expressions. Rejection occurs during import, save, and execution preflight; unsupported constructs are never displayed as runnable.

## Editor and execution

Create and open workflows from the collection sidebar. The editor presents the OWS JSON document, typed bindings, and a CSP-safe graph projection. Start and end rows are visual-only; they are not stored as custom workflow semantics.

Run results show the OWS task path and status. A missing, stale, non-HTTP, or method-mismatched binding stops the run before any network request is made.

## CLI and desktop projects

The CLI discovers and validates `workflows/<id>` artifacts in an OpenCollection workspace. Run one with `restura workflow run <workspace> <workflow-id>`; it resolves only the same approved HTTP saved-request binding and delegates to the existing CLI HTTP executor. Filesystem-backed desktop projects watch the workspace root, so OWS files participate in the existing Git status, diff, stage, and commit workflow without widening Git access beyond registered project directories.

## Removed Flow behavior

The legacy `requests[]` model, proprietary DAG nodes, QuickJS transform/template/display nodes, protocol exchange nodes, sub-workflow graph semantics, custom workflow envelopes, and legacy Flow imports are unavailable. Use collection scripts for request-level scripting; they are not workflow semantics.
