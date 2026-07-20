# Workflows

Restura workflows use the [Open Workflow Specification](https://openworkflowspec.org/) as their native execution format. `workflow.ows.json` is the only executable workflow document; Restura does not import, convert, retain, or execute its former linear or proprietary graph formats.

## Workspace artifacts

An OpenCollection workspace may contain portable workflows alongside its saved requests:

```text
opencollection.yml
workflows/<workflow-id>/workflow.ows.json
workflows/<workflow-id>/bindings.restura.json
workflows/<workflow-id>/layout.restura.json
```

- `workflow.ows.json` is normalized, validated, graphed, and serialized by `@openworkflowspec/sdk` in the Node workspace and CLI boundary. The renderer retains Electron's strict CSP and uses the same bounded profile without loading the SDK's dynamic code generator.
- `bindings.restura.json` maps a workflow task path to an approved saved-request reference. It contains no URLs, headers, credentials, environment values, scripts, or executable behavior.
- `layout.restura.json` is editor-only presentation metadata. It may be removed; Restura loads an empty layout and recreates it on the next save, without changing execution.

Saved-request references use a percent-encoded OpenCollection logical path, such as `Users/Get%20user`. A rename or deletion makes the binding stale and execution fails closed.

## Executable profile

The editor imports native OWS JSON or YAML, then normalizes it to canonical OWS JSON. Persistence and export use JSON only. Restura currently executes the bounded profile below:

- Sequential `do`, `set`, and `wait` tasks.
- Guarded paths using safe path references, comparisons, boolean operators, and parentheses.
- Bounded `for` loops over an array path (at most 1,000 iterations) and `try` / `catch` recovery paths.
- Root output projection using the same safe value references used by `set`.
- A task or workflow timeout, including cancellation propagation.
- HTTP and GraphQL `call` tasks that use `restura://saved-request` and an approved typed binding. GraphQL calls are dispatched through Restura's normal GraphQL adapter; a GraphQL response containing `errors` fails its workflow task.

The workflow task never supplies a real endpoint, headers, body, authentication, or transport. At run time, Restura resolves the bound saved request and sends it through the same protocol adapter, inherited authentication, SSRF policy, header policy, secret resolution, timeout, and cancellation boundary as a normal request. GraphQL mutations require a visible desktop confirmation and `restura workflow run --allow-mutations` in the CLI.

Restura currently rejects controls and transports without a complete safe runtime: `fork`, `switch`, event tasks, `run`, OpenAPI, AsyncAPI, MCP, A2A, inline authentication/secrets, schedules, opaque extensions, arbitrary scripts, and non-finite loops. Rejection occurs during import, save, and execution preflight; unsupported constructs are never displayed as runnable.

## Editor and execution

Create and open workflows from the collection sidebar. The editor presents a graph, advanced workflow JSON, and typed bindings. Start and end rows are visual-only; they are not stored as custom workflow semantics. The graph offers safe control blocks, typed data values, select/template values, output projection, and saved HTTP or GraphQL requests.

Advanced JSON uses an offline Monaco editor with bundled Restura-safe schemas, completion, hover help, formatting, folding, find, and a keyboard-accessible Problems list. It assists only the displayed bounded profile: upstream OWS controls that Restura cannot execute are absent from completion and receive a Restura-specific diagnostic. The schemas are never fetched, and no `$schema` field is added to saved workflow artifacts. `Validate & save` remains the authoritative validation gate.

Run results show the OWS task path and status. A missing, stale, non-HTTP, or method-mismatched binding stops the run before any network request is made.

## CLI and desktop projects

The CLI discovers and validates `workflows/<id>` artifacts in an OpenCollection workspace. Run one with `restura workflow run <workspace> <workflow-id>`; it resolves only approved saved-request bindings and delegates to the existing CLI HTTP or GraphQL executor. Pass `--allow-mutations` to run a workflow that contains a GraphQL mutation. Filesystem-backed desktop projects watch the workspace root, so workflow files participate in the existing Git status, diff, stage, and commit workflow without widening Git access beyond registered project directories.

## Removed Flow behavior

The legacy `requests[]` model, proprietary DAG nodes, QuickJS transform/template/display nodes, protocol exchange nodes, sub-workflow graph semantics, custom workflow envelopes, and legacy Flow imports are unavailable. Use collection scripts for request-level scripting; they are not workflow semantics.
