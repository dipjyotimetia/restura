# Restura

A multi-protocol API client that ships as a web app, a self-hosted server, and a desktop app, with an AI assistant that can read request context.

## Language

### Protocols

**Protocol**:
One of the nine things Restura can talk: HTTP, GraphQL, gRPC, WebSocket, Socket.IO, SSE, Kafka, MQTT, MCP.
_Avoid_: Mode, type, transport

**Request**:
A Protocol interaction that can be saved to a collection: HTTP, gRPC, SSE, MCP, GraphQL and WebSocket. GraphQL is stored as an HTTP Request with a GraphQL body.
_Avoid_: Call, message

**Session**:
A Protocol interaction that is never saved to a collection: Socket.IO, Kafka and MQTT. Its state lives only in its own protocol store.
_Avoid_: Connection (when meaning the whole user-facing interaction)

### Workspace

**Tab**:
An open, editable working copy of a Request. It is dirty when it differs from its saved original; a Tab with no saved original is unsaved until first saved.
_Avoid_: Request (for the editable copy), draft

**Collection**:
A saved, named tree of folders and Requests, with shared auth, variables and scripts inherited by the Requests beneath.
_Avoid_: Project, workspace

**History entry**:
A snapshot of a Request exactly as it was sent, with its response, independent of any saved version.
_Avoid_: Log, past request

### Running many Requests

**Collection run**:
Executing a Collection's Requests in tree order, with scripts passing state between them.
_Avoid_: Batch, runner

**Workflow**:
An authored flow (sequencing, branching, loops, typed data) that belongs to a Collection and calls its Requests.
_Avoid_: Pipeline, chain

**Load test**:
Repeating a single HTTP Request at a set iteration count and concurrency to measure performance, not correctness.
_Avoid_: Stress test, benchmark

### Variables and secrets

**Environment**:
A named set of Variables selected as the active context for sending Requests; may extend a base Environment.
_Avoid_: Profile, config

**Variable**:
A named value substituted into Requests, defined on an Environment, Collection or folder and inherited by what lies beneath.
_Avoid_: Parameter, constant

**Secret**:
A value whose plaintext the renderer must not hold; it is resolved only at the moment a Request is sent.
_Avoid_: Credential, sensitive value

**Secret reference**:
The pointer form of a Secret, either a local handle or an external provider reference (AWS, Google, Azure). Only the send path resolves it.
_Avoid_: Secret handle (as the umbrella), vault entry

**Private**:
A Variable flag meaning its value stays on this machine and is excluded from export and Git sync. It says nothing about the renderer seeing it.
_Avoid_: Secret, hidden

### Deployment

**Target**:
One of the three ways Restura ships from the single renderer: Desktop, Web, or Self-hosted.
_Avoid_: Platform, harness, environment

**Desktop**:
The Electron Target; the renderer talks to the Electron main process and there is no Worker.
_Avoid_: Electron app (when meaning the Target)

**Web**:
The Cloudflare Target; a static SPA on Pages talking to a Cloudflare Worker.
_Avoid_: Cloud, hosted

**Self-hosted**:
The Docker or Node Target; one Node process serves the SPA and the API on a single port.
_Avoid_: Docker build, on-prem

**Backend**:
What the renderer talks to for outbound traffic on a given Target: the Electron main process, the Cloudflare Worker, or the Node server.
_Avoid_: Server (for Desktop), proxy

### MCP

**MCP request**:
A Request in which Restura acts as an MCP client, calling a tool, resource or prompt on someone else's MCP server.
_Avoid_: MCP call, MCP connection

**MCP server mode**:
Restura acting as an MCP server, exposing its own collections and actions to an external agent.
_Avoid_: MCP integration, MCP plugin

### AI

Bare "run" is ambiguous across this repo; always qualify it (Collection run, Eval run, Arena run, Agent run).

**AI assistant**:
The in-app chat that can read the current Request and response context, with secrets and URLs redacted.
_Avoid_: Copilot, chatbot

**AI Lab**:
The Desktop-only workbench for testing prompts and models: Playground, Datasets, Evals, Arena and Agents.
_Avoid_: Eval workbench, LLM playground (as the whole)

**Dataset**:
A set of test cases (possibly multi-turn) that an Eval run scores models against.
_Avoid_: Test set, corpus

**Eval run**:
Scoring one or more models against a Dataset using scorers, such as deterministic checks, scripts, judges and tool-call checks.
_Avoid_: Benchmark, test run

**Arena run**:
Pairwise model-versus-model judging that produces an Elo leaderboard and win-rate matrix.
_Avoid_: Tournament, battle

**Agent run**:
A bounded, tool-using model loop executed against a versioned Agent suite, graded on its task and trace.
_Avoid_: Agent eval, agent session

### Mocks and contracts

**Mock server**:
A Desktop-only local server that replays responses recorded in History, or routes generated from a Collection's Contract, in place of a real upstream.
_Avoid_: Stub, fake API

**Contract**:
An OpenAPI or Swagger spec attached to a Collection or folder that describes what its Requests should send and receive.
_Avoid_: Schema, API definition
