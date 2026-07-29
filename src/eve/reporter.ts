import {
  AgentEvalsClient,
  type AgentEvalsRun,
  type CreateRunInput,
} from '../agentEvals.js'
import {
  EveSessionTraceStore,
  type EveTraceStoreOptions,
} from './traceStore.js'

interface FabricateTaskMetadata {
  readonly suiteId: string
  readonly key: string
}

export interface FabricateEveEvaluation {
  id: string
  metadata?: Record<string, unknown>
}

export interface FabricateEveTarget {
  url: string
  kind: string
}

export interface FabricateEveEvalResult {
  id: string
  verdict: string
  error?: string
  /** ISO timestamps from Eve's eval runner (wall-clock trial duration). */
  startedAt?: string
  completedAt?: string
  result: {
    status: string
    sessionId?: string
    derived: {
      failureCode?: string
    }
  }
}

function evalLatencyMs(result: FabricateEveEvalResult): number | undefined {
  if (!result.startedAt || !result.completedAt) return undefined
  const elapsed = Date.parse(result.completedAt) - Date.parse(result.startedAt)
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined
  return Math.round(elapsed)
}

export interface FabricateEveAttachment {
  filename: string
  contentType?: string
  data: Buffer | Uint8Array
}

export interface FabricateEveReporterLogger {
  log(message: string): void
  error(message: string): void
}

export interface FabricateEveReporterOptions extends EveTraceStoreOptions {
  client: AgentEvalsClient
  projectId: string
  /**
   * Workspace name required only when `getAttachments` returns files.
   */
  workspace?: string
  /**
   * Run fields added to the SDK-managed suite id and lifecycle status.
   */
  run?:
    | Omit<CreateRunInput, 'suite_id' | 'status'>
    | ((
        target: FabricateEveTarget,
      ) =>
        | Omit<CreateRunInput, 'suite_id' | 'status'>
        | Promise<Omit<CreateRunInput, 'suite_id' | 'status'>>)
  gradePollIntervalMs?: number
  gradePollTimeoutMs?: number
  getAttachments?: (
    result: FabricateEveEvalResult,
  ) =>
    | readonly FabricateEveAttachment[]
    | Promise<readonly FabricateEveAttachment[]>
  logger?: FabricateEveReporterLogger
}

function taskMetadata(
  evaluation: FabricateEveEvaluation,
): FabricateTaskMetadata {
  const value = evaluation.metadata?.agentEvals as
    | Partial<FabricateTaskMetadata>
    | undefined
  if (!value?.suiteId || !value.key) {
    throw new Error(
      `Eve eval ${evaluation.id} is missing metadata.agentEvals task fields. Create cases with createFabricateEveEvals or provide equivalent metadata.`,
    )
  }
  return { suiteId: value.suiteId, key: value.key }
}

/**
 * Native Eve reporter that creates a Fabricate run, reports OpenInference
 * trials, waits for Fabricate grading, and propagates failures to the eval CLI.
 */
export class FabricateEveReporter {
  private readonly options: FabricateEveReporterOptions
  private readonly store: EveSessionTraceStore
  private readonly logger: FabricateEveReporterLogger
  private run?: AgentEvalsRun
  private readonly tasks = new Map<string, FabricateTaskMetadata>()
  private readonly pendingGrades: { taskKey: string; trialId: string }[] = []
  private readonly reportingErrors: string[] = []
  private readonly failedGrades: string[] = []

  constructor(options: FabricateEveReporterOptions) {
    this.options = options
    this.store = new EveSessionTraceStore(options)
    this.logger = options.logger ?? console
  }

  async onRunStart(
    evaluations: readonly FabricateEveEvaluation[],
    target: FabricateEveTarget,
  ): Promise<void> {
    this.tasks.clear()
    this.pendingGrades.length = 0
    this.reportingErrors.length = 0
    this.failedGrades.length = 0

    for (const evaluation of evaluations) {
      this.tasks.set(evaluation.id, taskMetadata(evaluation))
    }

    const suiteIds = new Set(
      [...this.tasks.values()].map((task) => task.suiteId),
    )
    if (suiteIds.size !== 1) {
      throw new Error(
        `Fabricate Eve reporter expected one suite, received ${suiteIds.size}.`,
      )
    }

    const configuredRun =
      typeof this.options.run === 'function'
        ? await this.options.run(target)
        : this.options.run ?? {}

    this.run = await this.options.client.createRun(this.options.projectId, {
      ...configuredRun,
      suite_id: [...suiteIds][0],
      name:
        configuredRun.name ??
        `Eve native eval — ${new Date().toISOString()}`,
      status: 'in_progress',
      metadata: {
        runner: 'eve eval',
        eve_target: target.url,
        eve_target_kind: target.kind,
        ...configuredRun.metadata,
      },
    })
    this.logger.log(`Fabricate run: ${this.run.id}`)
  }

  async onEvalComplete(result: FabricateEveEvalResult): Promise<void> {
    if (!this.run || result.verdict === 'skipped') return
    const task = this.tasks.get(result.id)
    if (!task) return

    try {
      const executionFailed =
        result.verdict === 'failed' || result.result.status === 'failed'
      const executionError =
        result.error ??
        result.result.derived.failureCode ??
        'The Eve agent turn failed before Fabricate semantic grading.'
      const sessionId = result.result.sessionId
      const transcript = sessionId ? this.store.readSession(sessionId) : []

      if (transcript.length === 0) {
        if (!executionFailed) {
          throw new Error(
            `No OpenInference spans were exported for Eve session ${sessionId ?? '(unknown)'}.`,
          )
        }
        transcript.push({
          name: 'eve.execution',
          attributes: {
            'openinference.span.kind': 'AGENT',
            'output.value': executionError,
          },
        })
      }

      const attachmentUploadIds = await this.uploadAttachments(result)
      const trial = await this.options.client.reportTrial(this.run.id, {
        task_key: task.key,
        status: executionFailed ? 'error' : 'completed',
        latency_ms: evalLatencyMs(result),
        transcript: { messages: transcript },
        attachment_upload_ids: attachmentUploadIds,
        grade: !executionFailed,
        graders: executionFailed
          ? [
              {
                grader_name: 'eve-execution',
                assertions: [
                  {
                    assertion_name: 'agent_turn_completed',
                    passed: false,
                    score: 0,
                    reasoning: executionError,
                  },
                ],
              },
            ]
          : undefined,
      })

      if (executionFailed) {
        this.failedGrades.push(`${task.key} — ${executionError}`)
        this.logger.log(
          `Fabricate grade ${task.key}: FAIL (Eve execution failed)`,
        )
        return
      }

      this.pendingGrades.push({ taskKey: task.key, trialId: trial.id })
      this.logger.log(`Fabricate grade ${task.key}: pending`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reportingErrors.push(`${task.key}: ${message}`)
      this.logger.error(`Fabricate reporting failed for ${task.key}: ${message}`)
    } finally {
      if (result.result.sessionId) {
        this.store.clearSession(result.result.sessionId)
      }
    }
  }

  async onRunComplete(_summary: unknown): Promise<void> {
    if (!this.run) return

    const grading = await Promise.allSettled(
      this.pendingGrades.map(async ({ taskKey, trialId }) => ({
        taskKey,
        trial: await this.options.client.waitForGrading(trialId, {
          intervalMs: this.options.gradePollIntervalMs ?? 3000,
          timeoutMs: this.options.gradePollTimeoutMs ?? 300000,
        }),
      })),
    )

    grading.forEach((outcome, index) => {
      const taskKey = this.pendingGrades[index].taskKey
      if (outcome.status === 'rejected') {
        const message =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason)
        this.reportingErrors.push(`${taskKey}: ${message}`)
        return
      }

      const { trial } = outcome.value
      if (trial.grading?.status === 'failed') {
        this.reportingErrors.push(
          `${taskKey}: Fabricate grading failed${
            trial.grading.error ? ` — ${trial.grading.error}` : ''
          }`,
        )
      } else if (trial.passed !== true) {
        const reasoning = trial.graders
          ?.flatMap((grader) => grader.assertions ?? [])
          .map((assertion) => assertion.reasoning)
          .filter(Boolean)
          .join('; ')
        this.failedGrades.push(
          `${taskKey}${reasoning ? ` — ${reasoning}` : ''}`,
        )
      }
      this.logger.log(
        `Fabricate grade ${taskKey}: ${
          trial.passed === true ? 'PASS' : 'FAIL'
        }`,
      )
    })

    await this.options.client.updateRun(this.run.id, {
      status: this.reportingErrors.length > 0 ? 'failed' : 'completed',
    })

    if (this.reportingErrors.length > 0 || this.failedGrades.length > 0) {
      const failures = [
        ...this.reportingErrors.map(
          (message) => `reporting error: ${message}`,
        ),
        ...this.failedGrades.map(
          (message) => `Fabricate grade failed: ${message}`,
        ),
      ]
      throw new Error(`Agent Evals failures:\n${failures.join('\n')}`)
    }
  }

  private async uploadAttachments(
    result: FabricateEveEvalResult,
  ): Promise<string[] | undefined> {
    const attachments = await this.options.getAttachments?.(result)
    if (!attachments?.length) return undefined
    if (!this.options.workspace) {
      throw new Error(
        'Fabricate Eve reporter requires `workspace` when uploading attachments.',
      )
    }

    return Promise.all(
      attachments.map((attachment) =>
        this.options.client.uploadAttachment(this.options.workspace!, {
          filename: attachment.filename,
          content_type: attachment.contentType,
          data: attachment.data,
        }),
      ),
    )
  }
}

export function createFabricateEveReporter(
  options: FabricateEveReporterOptions,
): FabricateEveReporter {
  return new FabricateEveReporter(options)
}
