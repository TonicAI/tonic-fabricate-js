# Fabricate Client

The official [Fabricate](https://www.tonic.ai/products/fabricate) client for JavaScript and TypeScript.

- **Generate and download data** from a Fabricate database
- **Run workflows** and collect their results and files
- **Run agent evals** — score your own agent against suites in Fabricate

Requires Node.js 20+. Types included. The Eve adapter requires Node 24+.

## Installation

```bash
npm install @fabricate-tools/client
```

## Authentication

```bash
export FABRICATE_API_KEY="your-api-key"
```

`FABRICATE_API_URL` is optional and defaults to `https://fabricate.tonic.ai/api/v1`. Both can be passed directly as `apiKey` and `apiUrl` instead.

## Generate and download data

```typescript
import { generate } from '@fabricate-tools/client'

await generate({
  workspace: 'Default',
  database: 'ecommerce',
  format: 'postgres',
  dest: './data',
  overwrite: true,
})
```

| Option | |
| --- | --- |
| `workspace` | Required |
| `database` | Required |
| `format` | See below |
| `dest` | Required |
| `overwrite` | Replace `dest` if it exists. Default `false` |
| `unzip` | Unpack multi-table archives into `dest`. Default `true` |
| `onProgress` | Progress callback |

Formats: `csv`, `jsonl`, `json_array`, `postgres`, `mysql`, `sqlite`. On Enterprise plans also `mssql`, `oracle`, `bigquery`, `databricks`, `mongodb`, `xml`, `avro`, `parquet`, `iceberg`, `delta`.

### Progress

```typescript
await generate({
  workspace: 'Default',
  database: 'ecommerce',
  format: 'csv',
  dest: './data',
  onProgress: ({ percentComplete, phase, status }) => {
    console.log(`[${phase}] ${percentComplete}% ${status ?? ''}`)
  },
})
```

## Run a workflow

```typescript
import { runWorkflow } from '@fabricate-tools/client'

const { result, task, downloadFile, downloadAllFiles } = await runWorkflow({
  workspace: 'Default',
  project: 'my_project',
  workflow: 'my_workflow',
  params: { startDate: '2024-01-01', endDate: '2024-12-31' },
  onProgress: ({ status, message }) => console.log(`[${status}] ${message}`),
})

// Whatever the workflow passed to sendResult()
console.log(result)

for (const file of task.files ?? []) {
  await downloadFile(file.id, `./output/${file.name}`)
}

// Or all at once
await downloadAllFiles('./output')
```

To fetch a file later, outside the original call:

```typescript
import { downloadWorkflowFile } from '@fabricate-tools/client'

await downloadWorkflowFile({
  taskId: 'your-task-id',
  fileId: 123,
  destPath: './output/report.csv',
})
```

## Agent evals

Run your agent against a suite in Fabricate and let Fabricate's graders score it. Bring your own agent; report each run as [OpenInference](https://github.com/Arize-ai/openinference) spans.

```typescript
import { AgentEvalsClient } from '@fabricate-tools/client'

const client = new AgentEvalsClient()

// Fabricate is the source of truth for the suite and its tasks
const suite = await client.findSuite(projectId, { name: 'Agent Eval Tasks' })
if (!suite) throw new Error('Suite not found')

const tasks = await client.listTasks(suite.id)

const run = await client.createRun(projectId, {
  suite_id: suite.id,
  model: 'gpt-5-mini',
  git_branch: process.env.GIT_BRANCH,
})

for (const task of tasks) {
  const transcript = await runYourAgent(task.input) // your code -> OpenInference spans

  const trial = await client.reportTrial(run.id, {
    task_key: task.key,
    transcript: { messages: transcript },
    grade: true,
  })

  const graded = await client.waitForGrading(trial.id)
  console.log(task.key, graded.passed ? 'PASS' : 'FAIL')
}

// Close the run so dashboard totals update
await client.updateRun(run.id, { status: 'completed' })
```

`waitForGrading` polls every 3s and times out after 2 minutes — adjust with `intervalMs`, `timeoutMs`, or an `AbortSignal`.

### Attachments

Give the graders a file to inspect:

```typescript
const uploadId = await client.uploadAttachment(workspace, {
  filename: 'payments.csv',
  content_type: 'text/csv',
  data: Buffer.from(csvText),
})

await client.reportTrial(run.id, {
  task_key: 'payments-csv',
  transcript: { messages: transcript },
  attachment_upload_ids: [uploadId],
  grade: true,
})
```

### Tasks and graders defined in your repo

Skip creating definitions in Fabricate and send them with the trial:

```typescript
const run = await client.createRun(projectId, { suite_name: 'Git-defined evals', model })

await client.reportTrial(run.id, {
  task: { key: 'users', input: 'Generate 100 users', tags: ['users'] },
  grader_definitions: [{ name: 'quality', prompt: 'Inspect the attached data.', tags: ['users'] }],
  transcript: { messages: spans },
  attachment_upload_ids: uploadIds,
  grade: true,
})
```

### Versions

Suites, fixtures, and graders are versioned independently, and you get the latest of each by default.

```typescript
await client.findSuite(projectId, { name: 'Agent Eval Tasks' })             // latest
await client.findSuite(projectId, { name: 'Agent Eval Tasks', version: 2 }) // pinned
await client.findSuite(projectId, { id: suiteVersionId })
```

Note that `suite.id` is the *version* — that's what `listTasks` and `createRun` want. `suite.suite_id` is the stable ID across versions.

Pin a run's inputs with `fixture_overrides` and `grader_overrides`:

```typescript
await client.createRun(projectId, {
  suite_id: suite.id,
  fixture_overrides: [{ fixture_id: 'fixture-uuid', fixture_version_id: 'fixture-version-uuid' }],
  grader_overrides: [{ grader_id: 'grader-uuid', grader_version_id: 'grader-version-uuid' }],
})
```

Runs snapshot what they resolved, so later edits never change recorded results. To branch a new version from an existing one: `createSuiteVersion(suite.id)`, `createFixtureVersion(fixtureVersionId)`, `createGraderVersion(graderVersionId)`.

Trials record `cache_read_tokens`, `cache_write_5m_tokens`, and `cache_write_1h_tokens`, derived from `llm.token_count.prompt_details.*` attributes when your spans carry them.

## Eve adapter

For [Eve](https://www.npmjs.com/package/eve) projects, `@fabricate-tools/client/eve` wires up trace capture, reporting, and grading for you.

```bash
npm install @fabricate-tools/client eve @arizeai/openinference-vercel \
  @opentelemetry/core @opentelemetry/sdk-trace-base @vercel/otel
```

`agent/instrumentation.ts`:

```typescript
import { createFabricateEveInstrumentation } from '@fabricate-tools/client/eve'

export default createFabricateEveInstrumentation({
  // Optional: add provider-reported llm.cost.* attributes here
  enrichAttributes: (attributes) => attributes,
})
```

Build evals from your suite:

```typescript
import { AgentEvalsClient } from '@fabricate-tools/client'
import { createFabricateEveEvals } from '@fabricate-tools/client/eve'

export default await createFabricateEveEvals({
  client: new AgentEvalsClient(),
  projectId: process.env.FABRICATE_PROJECT_ID!,
  suite: { id: process.env.FABRICATE_SUITE_ID! }, // a suite *version* UUID
  prepareTask: async (task) => {
    // Materialize task.effective_fixture for this case
  },
})
```

`evals/evals.config.ts`:

```typescript
import { defineEvalConfig } from 'eve/evals'
import { AgentEvalsClient } from '@fabricate-tools/client'
import { createFabricateEveReporter } from '@fabricate-tools/client/eve'

export default defineEvalConfig({
  reporters: [
    createFabricateEveReporter({
      client: new AgentEvalsClient(),
      projectId: process.env.FABRICATE_PROJECT_ID!,
      run: { model: process.env.AGENT_MODEL, git_sha: process.env.GIT_SHA },
    }),
  ],
})
```

The reporter opens one run, reports every trial, waits for grading, closes the run, and fails `eve eval` if anything fails.

## License

MIT
