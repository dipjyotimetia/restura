# Request Chaining & Workflows

Workflows allow you to execute multiple API requests sequentially, passing data between them. This is similar to Postman's Flows feature and is essential for testing complex API scenarios like authentication flows, CRUD operations, and multi-step processes.

## Overview

A workflow consists of:
- **Steps**: Individual requests executed in sequence
- **Variable Extractions**: Rules to extract data from responses
- **Preconditions**: Scripts that determine if a step should run
- **Retry Policies**: Automatic retry configuration for failed requests

## Use Cases

- **Authentication flows**: Login → Get token → Use token in subsequent requests
- **CRUD operations**: Create → Read → Update → Delete
- **Data pipelines**: Fetch list → Process each item → Aggregate results
- **Integration testing**: Test complete user journeys

## Creating a Workflow

### From the Sidebar

1. Open the sidebar and click the **Workflows** tab
2. Select a collection to add workflows to
3. Click **Create Workflow** or the `+` button
4. Enter a name for your workflow

### Adding Steps

1. Open a workflow by clicking on it
2. Click **Add Step**
3. Select a request from your collection
4. Configure the step (optional):
   - **Name**: Display name for the step
   - **Extractions**: Variables to extract from the response
   - **Precondition**: Script to conditionally execute
   - **Retry Policy**: Retry configuration

## Variable Extraction

Extract values from responses to use in subsequent requests. Variables are automatically injected using `{{variableName}}` syntax.

### Extraction Methods

#### JSONPath (Dot Notation)

Extract values from JSON responses using dot notation:

```
data.user.id          → Extracts nested property
data.users[0].name    → Extracts from array
data.token            → Extracts simple property
```

**Example Response:**
```json
{
  "data": {
    "user": {
      "id": "usr_123",
      "name": "John Doe"
    },
    "token": "eyJhbG..."
  }
}
```

**Extractions:**
- `data.user.id` → `usr_123`
- `data.token` → `eyJhbG...`

#### Regex

Extract values using regular expressions with capture groups:

```
"token":"([^"]+)"     → Captures token value
id=(\d+)              → Captures numeric ID
Bearer\s+(\S+)        → Captures bearer token
```

**Example:**
- Body: `{"token":"abc123","user":"john"}`
- Pattern: `"token":"([^"]+)"`
- Result: `abc123`

#### Header

Extract values from response headers:

```
X-Request-Id          → Gets custom header
Authorization         → Gets auth header
Set-Cookie           → Gets cookies (joined if multiple)
```

### Using Extracted Variables

Extracted variables are automatically available in subsequent steps. Use them with double curly braces:

```
URL: https://api.example.com/users/{{userId}}
Header: Authorization: Bearer {{token}}
Body: {"userId": "{{userId}}"}
```

## Preconditions

Control whether a step executes based on current variables.

### Writing Preconditions

Preconditions are JavaScript expressions that must return `true` for the step to execute:

```javascript
// Check if token exists
return environment.get('token') !== undefined;

// Check if status is valid
return environment.get('status') === 'active';

// Numeric comparison
return parseInt(environment.get('count')) > 0;
```

### Skipped Steps

When a precondition returns `false`, the step is marked as **skipped** and execution continues with the next step.

## Retry Policies

Configure automatic retries for failed requests.

### Options

- **Max Attempts**: Number of times to retry (1-10)
- **Delay**: Milliseconds between retries
- **Backoff Multiplier**: Multiply delay after each retry (exponential backoff)

### Example

```javascript
{
  maxAttempts: 3,
  delayMs: 1000,
  backoffMultiplier: 2
}
```

Retry timeline:
1. Initial request fails → wait 1000ms
2. Retry 1 fails → wait 2000ms
3. Retry 2 fails → wait 4000ms
4. Retry 3 (final attempt)

## Running Workflows

### From the Workflow Builder

1. Open the workflow
2. Click **Run Workflow**
3. Monitor progress in real-time

### Execution View

The executor shows three tabs:

#### Steps Tab
- Visual progress of each step
- Status icons (pending, running, success, failed, skipped)
- Response status and duration
- Extracted variables per step

#### Variables Tab
- All variables available after execution
- Final values including all extractions

#### Logs Tab
- Timestamped execution log
- Info, warning, and error messages
- Useful for debugging

### Stopping Execution

Click **Stop** to abort a running workflow. The current request will complete, but subsequent steps won't execute.

## Workflow Variables

Define workflow-level variables that are available to all steps:

1. Open workflow settings
2. Add key-value pairs
3. Enable/disable individual variables

These merge with environment variables, with workflow variables taking precedence.

## API Reference

### Types

```typescript
interface Workflow {
  id: string;
  name: string;
  description?: string;
  collectionId: string;
  requests: WorkflowRequest[];
  variables?: KeyValue[];
  createdAt: number;
  updatedAt: number;
}

interface WorkflowRequest {
  id: string;
  requestId: string;
  name: string;
  extractVariables?: VariableExtraction[];
  precondition?: string;
  retryPolicy?: {
    maxAttempts: number;
    delayMs: number;
    backoffMultiplier?: number;
  };
  timeout?: number;
}

interface VariableExtraction {
  id: string;
  variableName: string;
  extractionMethod: 'jsonpath' | 'regex' | 'header';
  path: string;
  description?: string;
}
```

### Store API

```typescript
import { useWorkflowStore } from '@/store/useWorkflowStore';

// Get workflows for a collection
const workflows = useWorkflowStore(s => s.getWorkflowsByCollectionId(collectionId));

// Create a workflow
const workflow = useWorkflowStore.getState().createNewWorkflow('My Flow', collectionId);
useWorkflowStore.getState().addWorkflow(workflow);

// Add a step
useWorkflowStore.getState().addWorkflowRequest(workflowId, {
  id: 'step-1',
  requestId: 'req-123',
  name: 'Get User',
  extractVariables: [
    {
      id: 'ext-1',
      variableName: 'userId',
      extractionMethod: 'jsonpath',
      path: 'data.id'
    }
  ]
});
```

### Hook API

```typescript
import { useWorkflowExecution } from '@/features/workflows';

function MyComponent() {
  const { isRunning, execution, logs, run, stop } = useWorkflowExecution({
    onComplete: (execution) => console.log('Done!', execution),
    onError: (error) => console.error('Failed:', error)
  });

  const handleRun = async () => {
    const result = await run(workflow);
    console.log('Variables:', result.finalVariables);
  };

  return (
    <button onClick={handleRun} disabled={isRunning}>
      {isRunning ? 'Running...' : 'Run'}
    </button>
  );
}
```

### Executor API

```typescript
import { executeWorkflow } from '@/features/workflows';

const execution = await executeWorkflow({
  workflow,
  getRequestById: (id) => findRequest(id),
  envVars: { baseUrl: 'https://api.example.com' },
  globalSettings: settings,
  resolveVariables: (text) => text.replace(/\{\{(\w+)\}\}/g, ...),
  onStepStart: (step) => console.log('Starting:', step.requestName),
  onStepComplete: (step) => console.log('Completed:', step.status),
  onLog: (message, level) => console.log(`[${level}]`, message),
  abortSignal: controller.signal
});

console.log('Status:', execution.status);
console.log('Variables:', execution.finalVariables);
```

## Examples

### Authentication Flow

```javascript
// Workflow: User Authentication
// Step 1: Login
{
  requestId: 'login-request',
  name: 'Login',
  extractVariables: [
    { variableName: 'accessToken', path: 'data.accessToken' },
    { variableName: 'refreshToken', path: 'data.refreshToken' }
  ]
}

// Step 2: Get User Profile
{
  requestId: 'profile-request',  // Uses {{accessToken}} in Authorization header
  name: 'Get Profile',
  extractVariables: [
    { variableName: 'userId', path: 'data.user.id' }
  ]
}

// Step 3: Update Profile
{
  requestId: 'update-request',  // Uses {{userId}} in URL
  name: 'Update Profile'
}
```

### Conditional Execution

```javascript
// Step with precondition
{
  requestId: 'admin-only-request',
  name: 'Admin Operation',
  precondition: `return environment.get('userRole') === 'admin';`
}
```

### Retry on Failure

```javascript
// Step with retry policy
{
  requestId: 'flaky-api-request',
  name: 'Call External API',
  retryPolicy: {
    maxAttempts: 3,
    delayMs: 2000,
    backoffMultiplier: 1.5
  }
}
```

## Best Practices

1. **Name steps clearly**: Use descriptive names that explain what each step does
2. **Extract only what you need**: Don't over-extract; keep variables focused
3. **Use preconditions wisely**: For optional steps, not error handling
4. **Set appropriate timeouts**: Override global timeout for slow endpoints
5. **Test extractions**: Use the preview feature to verify extraction paths
6. **Keep workflows focused**: One workflow per user journey or test scenario

## Troubleshooting

### Variable not being replaced

- Check the variable name matches exactly (case-sensitive)
- Verify the extraction path is correct
- Check the previous step succeeded

### Precondition always fails

- Ensure script returns a boolean
- Check variable names in `environment.get()`
- Test the script logic separately

### Workflow stops unexpectedly

- Check the Logs tab for errors
- Verify all request IDs are valid
- Check for network/CORS issues

### Extraction returns undefined

- Verify the response body is valid JSON
- Check the path syntax (use dots, not brackets for objects)
- For arrays, ensure the index exists
