import got, { HTTPError } from 'got'

// Framework-agnostic client for Fabricate's Agent Testing API (v1). It covers
// suites, tasks, fixtures, grader definitions, runs, trials (including
// Fabricate-graded trials), and trial attachments. It has no dependency on any
// agent framework; callers convert their own runs into the transcript shape.

// ── Shared types ────────────────────────────────────────────────────────────

/** Status of an evaluation run or a reported trial's overall lifecycle. */
export type AgentTestingRunStatus = 'in_progress' | 'completed' | 'failed'

/** Status a reported trial can carry. */
export type AgentTestingTrialStatus = 'completed' | 'failed' | 'error'

/**
 * One OpenInference span in a trial transcript. `name` is a non-blank span
 * name; `attributes` uses the flattened OpenInference semantic-convention keys
 * (e.g. `openinference.span.kind`, `llm.input_messages.0.message.role`).
 */
export interface OpenInferenceSpan {
  name: string
  attributes: Record<string, unknown>
}

export interface AgentTestingProject {
  id: string
  name: string
  description: string | null
  workspace_id: string
}

export interface AgentTestingSuite {
  id: string
  project_id: string
  name: string
  version_tag: string | null
  description: string | null
  tags: string[]
  task_count: number
  default_fixture_id: string | null
  default_fixture: AgentTestingFixture | null
}

export interface AgentTestingTask {
  id: string
  suite_id: string
  key: string
  input: string
  expected_output: string | null
  tags: string[]
  input_token_limit: number | null
  output_token_limit: number | null
  fixture_id: string | null
  effective_fixture: AgentTestingFixture | null
}

/** A resolved/typed entry inside a fixture manifest. */
export interface AgentTestingFixtureEntry {
  id: string
  key: string
  type: 'database' | 'table' | 'workflow' | 'mock_api'
  value: Record<string, unknown>
  position: number
  resource: Record<string, unknown> | null
  diagnostic: { code: string; message: string } | null
}

export interface AgentTestingFixture {
  id: string
  project_id: string
  name: string
  description: string | null
  entries: AgentTestingFixtureEntry[]
  created_at?: string
  updated_at?: string
}

/** Input entry when creating or replacing a fixture manifest. */
export interface AgentTestingFixtureEntryInput {
  key: string
  type: 'database' | 'table' | 'workflow' | 'mock_api'
  value: Record<string, unknown>
}

export type AgentTestingGraderKind = 'llm_judge' | 'script'

export interface AgentTestingGraderDefinition {
  id: string
  project_id: string
  name: string
  description: string | null
  kind: AgentTestingGraderKind
  prompt: string | null
  code: string | null
  model: string | null
  tags: string[]
}

export interface AgentTestingRun {
  id: string
  project_id: string
  run_number: number
  suite_id: string | null
  suite_name: string | null
  suite_version_tag: string | null
  git_branch: string | null
  git_sha: string | null
  git_repo_url: string | null
  model: string | null
  name: string | null
  status: AgentTestingRunStatus
  started_at: string | null
  completed_at: string | null
  aggregate_metrics: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export interface AgentTestingRunWithTrials extends AgentTestingRun {
  trials: AgentTestingTrialSummary[]
}

export interface AgentTestingAssertion {
  id?: string
  assertion_name: string
  passed: boolean | null
  score: number | null
  reasoning: string | null
}

export interface AgentTestingGrader {
  id?: string
  grader_name: string
  passed: boolean | null
  assertions: AgentTestingAssertion[]
}

export interface AgentTestingGrading {
  id: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  graders_total: number
  graders_completed: number
  error: string | null
  started_at: string | null
  completed_at: string | null
}

export interface AgentTestingAttachment {
  id: string
  filename: string
  content_type: string | null
  byte_size: number
}

export interface AgentTestingTrialSummary {
  id: string
  run_id: string
  task_id: string | null
  task_key: string
  task_name: string | null
  trial_number: number
  status: string
  passed: boolean | null
  cost: number | null
  latency_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
}

export interface AgentTestingTrial extends AgentTestingTrialSummary {
  task_input?: string
  task_expected_output?: string | null
  transcript?: { id: string; messages: OpenInferenceSpan[] } | null
  prompt_context?: unknown
  fixture?: AgentTestingFixture | null
  attachments?: AgentTestingAttachment[]
  graders?: AgentTestingGrader[]
  grading?: AgentTestingGrading | null
}

// ── Request payloads ──────────────────────────────────────────────────────────

export interface FindOrCreateSuiteInput {
  name: string
  version_tag?: string
  description?: string
  tags?: readonly string[]
  default_fixture_id?: string
}

export interface UpsertTaskInput {
  key: string
  input: string
  expected_output?: string
  tags?: readonly string[]
  fixture_id?: string
  input_token_limit?: number
  output_token_limit?: number
}

export interface FixtureInput {
  name: string
  description?: string
  entries?: readonly AgentTestingFixtureEntryInput[]
}

export interface FindOrCreateGraderDefinitionInput {
  name: string
  description?: string
  kind?: AgentTestingGraderKind
  prompt?: string
  code?: string
  model?: string
  tags?: readonly string[]
}

export interface CreateRunInput {
  suite_id?: string
  suite_name?: string
  suite_version_tag?: string
  git_branch?: string
  git_sha?: string
  git_repo_url?: string
  model?: string
  name?: string
  status?: AgentTestingRunStatus
  metadata?: Record<string, unknown>
}

export interface ReportTrialInput {
  task_key: string
  task_input?: string
  task_expected_output?: string
  task_tags?: readonly string[]
  task_input_token_limit?: number
  task_output_token_limit?: number
  trial_number?: number
  status?: AgentTestingTrialStatus
  cost?: number
  latency_ms?: number
  input_tokens?: number
  output_tokens?: number
  cached_tokens?: number
  transcript: { messages: readonly OpenInferenceSpan[] }
  attachment_upload_ids?: readonly string[]
  /** Client-computed grader results. Ignored when `grade` is true. */
  graders?: readonly {
    grader_name: string
    assertions: readonly {
      assertion_name: string
      passed?: boolean
      score?: number
      reasoning?: string
    }[]
  }[]
  /**
   * Have Fabricate's LLM-as-judge grade this trial asynchronously against the
   * project's grader definitions instead of accepting client-supplied graders.
   */
  grade?: boolean
}

/** Response from minting a pending trial-attachment upload. */
export interface AgentTestingUpload {
  upload_id: string
  upload_url: string
  method: string
  max_bytes: number
  expires_at: string
  instructions: string
}

export interface WaitForGradingOptions {
  /** Poll interval in milliseconds. Default 3000. */
  intervalMs?: number
  /** Overall timeout in milliseconds. Default 120000. */
  timeoutMs?: number
  /** Abort signal to cancel polling early. */
  signal?: AbortSignal
}

export interface AgentTestingClientOptions {
  /** Fabricate API key. Defaults to the `FABRICATE_API_KEY` environment variable. */
  apiKey?: string
  /**
   * Base API URL including the `/api/v1` suffix. Defaults to the
   * `FABRICATE_API_URL` environment variable, then
   * `https://fabricate.tonic.ai/api/v1`.
   */
  apiUrl?: string
}

/** Error thrown for any non-2xx Agent Testing API response. */
export class AgentTestingError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Fabricate agent testing request ${method} ${path} failed with ${status}: ${body}`)
    this.name = 'AgentTestingError'
  }
}

const enc = encodeURIComponent

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Client for the Fabricate Agent Testing API. Each method maps to a v1
 * endpoint; the higher-level helpers (`findSuite`, `waitForGrading`,
 * `uploadAttachment`) compose those calls for common workflows.
 */
export class AgentTestingClient {
  private readonly apiKey: string
  private readonly apiUrl: string

  constructor(options: AgentTestingClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.FABRICATE_API_KEY
    if (!apiKey) {
      throw new Error('apiKey is required (set it explicitly or via FABRICATE_API_KEY)')
    }
    this.apiKey = apiKey
    this.apiUrl = (options.apiUrl ?? process.env.FABRICATE_API_URL ?? 'https://fabricate.tonic.ai/api/v1').replace(/\/+$/, '')
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: { json?: unknown; searchParams?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const searchParams: Record<string, string> = {}
    for (const [key, value] of Object.entries(options.searchParams ?? {})) {
      if (value !== undefined && value !== '') searchParams[key] = value
    }

    try {
      const response = await got(`${this.apiUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        json: options.json as object | undefined,
        searchParams: Object.keys(searchParams).length > 0 ? searchParams : undefined,
        responseType: 'text',
        throwHttpErrors: true,
      })
      const body = response.body as string
      return (body ? JSON.parse(body) : undefined) as T
    } catch (error) {
      if (error instanceof HTTPError) {
        const body = typeof error.response.body === 'string' ? error.response.body : JSON.stringify(error.response.body)
        throw new AgentTestingError(error.response.statusCode, method, path, body)
      }
      throw error
    }
  }

  // ── Projects ────────────────────────────────────────────────────────────

  listProjects(workspace: string): Promise<AgentTestingProject[]> {
    return this.request('GET', `/workspaces/${enc(workspace)}/projects`)
  }

  findOrCreateProject(workspace: string, input: { name: string; description?: string }): Promise<AgentTestingProject> {
    return this.request('POST', `/workspaces/${enc(workspace)}/projects`, { json: input })
  }

  // ── Suites ──────────────────────────────────────────────────────────────

  listSuites(projectId: string): Promise<AgentTestingSuite[]> {
    return this.request('GET', `/projects/${enc(projectId)}/suites`)
  }

  findOrCreateSuite(projectId: string, input: FindOrCreateSuiteInput): Promise<AgentTestingSuite> {
    return this.request('POST', `/projects/${enc(projectId)}/suites`, { json: input })
  }

  /**
   * Find an existing suite by id, or by name and optional version tag, without
   * creating one. Returns undefined when no suite matches.
   */
  async findSuite(projectId: string, selector: { id?: string; name?: string; versionTag?: string }): Promise<AgentTestingSuite | undefined> {
    const suites = await this.listSuites(projectId)
    if (selector.id) {
      return suites.find((suite) => suite.id === selector.id)
    }
    if (selector.name) {
      const wanted = selector.versionTag ?? undefined
      return suites.find((suite) => suite.name.toLowerCase() === selector.name!.toLowerCase() && (suite.version_tag ?? undefined) === wanted)
    }
    return undefined
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  listTasks(suiteId: string): Promise<AgentTestingTask[]> {
    return this.request('GET', `/suites/${enc(suiteId)}/tasks`)
  }

  upsertTask(suiteId: string, input: UpsertTaskInput): Promise<AgentTestingTask> {
    return this.request('POST', `/suites/${enc(suiteId)}/tasks`, { json: input })
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────

  listFixtures(projectId: string): Promise<AgentTestingFixture[]> {
    return this.request('GET', `/projects/${enc(projectId)}/fixtures`)
  }

  findOrCreateFixture(projectId: string, input: FixtureInput): Promise<AgentTestingFixture> {
    return this.request('POST', `/projects/${enc(projectId)}/fixtures`, { json: input })
  }

  getFixture(fixtureId: string): Promise<AgentTestingFixture> {
    return this.request('GET', `/fixtures/${enc(fixtureId)}`)
  }

  updateFixture(
    fixtureId: string,
    input: { name?: string; description?: string; entries?: readonly AgentTestingFixtureEntryInput[] },
  ): Promise<AgentTestingFixture> {
    return this.request('PATCH', `/fixtures/${enc(fixtureId)}`, { json: input })
  }

  async deleteFixture(fixtureId: string): Promise<void> {
    await this.request('DELETE', `/fixtures/${enc(fixtureId)}`)
  }

  /**
   * Download the current SQLite contents of a database referenced by a fixture
   * entry. The same account API key and workspace permissions apply.
   */
  async downloadFixtureDatabase(fixtureId: string, databaseId: string): Promise<Buffer> {
    const path = `/fixtures/${enc(fixtureId)}/databases/${enc(databaseId)}`
    try {
      const response = await got(`${this.apiUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        responseType: 'buffer',
        throwHttpErrors: true,
      })
      return response.body
    } catch (error) {
      if (error instanceof HTTPError) {
        const body = Buffer.isBuffer(error.response.body) ? error.response.body.toString('utf8') : String(error.response.body)
        throw new AgentTestingError(error.response.statusCode, 'GET', path, body)
      }
      throw error
    }
  }

  // ── Grader definitions ──────────────────────────────────────────────────

  listGraderDefinitions(projectId: string): Promise<AgentTestingGraderDefinition[]> {
    return this.request('GET', `/projects/${enc(projectId)}/grader_definitions`)
  }

  findOrCreateGraderDefinition(projectId: string, input: FindOrCreateGraderDefinitionInput): Promise<AgentTestingGraderDefinition> {
    return this.request('POST', `/projects/${enc(projectId)}/grader_definitions`, { json: input })
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  listRuns(projectId: string, options: { branch?: string } = {}): Promise<AgentTestingRun[]> {
    return this.request('GET', `/projects/${enc(projectId)}/runs`, { searchParams: { branch: options.branch } })
  }

  createRun(projectId: string, input: CreateRunInput = {}): Promise<AgentTestingRun> {
    return this.request('POST', `/projects/${enc(projectId)}/runs`, { json: input })
  }

  getRun(runId: string): Promise<AgentTestingRunWithTrials> {
    return this.request('GET', `/runs/${enc(runId)}`)
  }

  updateRun(runId: string, input: { status?: AgentTestingRunStatus; metadata?: Record<string, unknown> }): Promise<AgentTestingRun> {
    return this.request('PATCH', `/runs/${enc(runId)}`, { json: input })
  }

  // ── Trials ──────────────────────────────────────────────────────────────

  reportTrial(runId: string, input: ReportTrialInput): Promise<AgentTestingTrial> {
    return this.request('POST', `/runs/${enc(runId)}/trials`, { json: input })
  }

  getTrial(trialId: string): Promise<AgentTestingTrial> {
    return this.request('GET', `/trials/${enc(trialId)}`)
  }

  /**
   * Poll a Fabricate-graded trial (reported with `grade: true`) until its
   * grading settles (`completed`/`failed`) or the timeout elapses. Returns the
   * final trial with its populated `graders`.
   */
  async waitForGrading(trialId: string, options: WaitForGradingOptions = {}): Promise<AgentTestingTrial> {
    const intervalMs = options.intervalMs ?? 3000
    const timeoutMs = options.timeoutMs ?? 120000
    const deadline = Date.now() + timeoutMs

    let trial = await this.getTrial(trialId)
    while (trial.grading && trial.grading.status !== 'completed' && trial.grading.status !== 'failed') {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for trial ${trialId} grading.`)
      }
      await delay(intervalMs, options.signal)
      trial = await this.getTrial(trialId)
    }
    return trial
  }

  // ── Attachments ───────────────────────────────────────────────────────────

  /** Step 1 of the attachment handshake: mint a pending upload. */
  createUpload(workspace: string, input: { filename: string; content_type?: string }): Promise<AgentTestingUpload> {
    // Legacy backend route retains the internal codename; kept private here.
    return this.request('POST', `/workspaces/${enc(workspace)}/agent_bench/uploads`, { json: input })
  }

  /** Step 2 of the attachment handshake: PUT the raw file bytes to `uploadUrl`. */
  async putUploadBytes(uploadUrl: string, data: Buffer | Uint8Array, contentType?: string): Promise<void> {
    try {
      await got.put(uploadUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        body: Buffer.from(data),
        responseType: 'text',
        throwHttpErrors: true,
      })
    } catch (error) {
      if (error instanceof HTTPError) {
        const body = typeof error.response.body === 'string' ? error.response.body : JSON.stringify(error.response.body)
        throw new AgentTestingError(error.response.statusCode, 'PUT', uploadUrl, body)
      }
      throw error
    }
  }

  /**
   * Upload a trial attachment in one call (mint + PUT) and return the
   * `upload_id` to pass in `reportTrial({ attachment_upload_ids })`.
   */
  async uploadAttachment(workspace: string, input: { filename: string; content_type?: string; data: Buffer | Uint8Array }): Promise<string> {
    const upload = await this.createUpload(workspace, {
      filename: input.filename,
      content_type: input.content_type,
    })
    await this.putUploadBytes(upload.upload_url, input.data, input.content_type)
    return upload.upload_id
  }
}
