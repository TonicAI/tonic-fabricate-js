import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { OpenInferenceSpan } from '../agentEvals.js'

/**
 * Default on-disk location shared by the Eve agent process and eval reporter.
 */
export const DEFAULT_EVE_TRACE_DIRECTORY = resolve(
  process.cwd(),
  '.eve',
  'fabricate-agent-evals-traces',
)

/**
 * Eve attaches this session identifier to the parent telemetry span.
 */
export const EVE_SESSION_ATTRIBUTE = 'eve.session.id'

export type EveSpanAttributesEnricher = (
  attributes: Record<string, unknown>,
  span: ReadableSpan,
) => Record<string, unknown> | void

export interface EveTraceStoreOptions {
  directory?: string
  sessionAttribute?: string
}

export interface EveSessionFileSpanExporterOptions extends EveTraceStoreOptions {
  /**
   * Optionally add client-known OpenInference attributes before persistence.
   * Use this for provider-reported costs; do not estimate unknown pricing.
   */
  enrichAttributes?: EveSpanAttributesEnricher
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * File-backed span store used across Eve's agent and eval processes.
 */
export class EveSessionTraceStore {
  readonly directory: string
  readonly sessionAttribute: string

  constructor(options: EveTraceStoreOptions = {}) {
    this.directory = resolve(options.directory ?? DEFAULT_EVE_TRACE_DIRECTORY)
    this.sessionAttribute = options.sessionAttribute ?? EVE_SESSION_ATTRIBUTE
  }

  append(traceId: string, span: OpenInferenceSpan): void {
    mkdirSync(this.directory, { recursive: true })
    appendFileSync(this.tracePath(traceId), `${JSON.stringify(span)}\n`, 'utf8')
  }

  indexSession(sessionId: string, traceId: string): void {
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(this.sessionIndexPath(sessionId), traceId, 'utf8')
  }

  readSession(sessionId: string): OpenInferenceSpan[] {
    const index = this.sessionIndexPath(sessionId)
    if (!existsSync(index)) return []

    const traceId = readFileSync(index, 'utf8').trim()
    const path = this.tracePath(traceId)
    if (!existsSync(path)) return []

    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OpenInferenceSpan)
  }

  clearSession(sessionId: string): void {
    const index = this.sessionIndexPath(sessionId)
    if (existsSync(index)) {
      const traceId = readFileSync(index, 'utf8').trim()
      rmSync(this.tracePath(traceId), { force: true })
    }
    rmSync(index, { force: true })
  }

  private tracePath(traceId: string): string {
    return resolve(this.directory, `trace-${safeName(traceId)}.jsonl`)
  }

  private sessionIndexPath(sessionId: string): string {
    return resolve(this.directory, `session-${safeName(sessionId)}.txt`)
  }
}

/**
 * OTel exporter used behind OpenInferenceSimpleSpanProcessor. Spans are already
 * transformed to OpenInference before this exporter receives them.
 */
export class EveSessionFileSpanExporter implements SpanExporter {
  private readonly store: EveSessionTraceStore
  private readonly enrichAttributes?: EveSpanAttributesEnricher

  constructor(options: EveSessionFileSpanExporterOptions = {}) {
    this.store = new EveSessionTraceStore(options)
    this.enrichAttributes = options.enrichAttributes
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    try {
      for (const span of spans) {
        const traceId = span.spanContext().traceId
        if (!traceId) continue

        const sessionId = span.attributes[this.store.sessionAttribute]
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          this.store.indexSession(sessionId, traceId)
        }

        const baseAttributes: Record<string, unknown> = {
          ...span.attributes,
        }
        const enriched =
          this.enrichAttributes?.(baseAttributes, span) ?? baseAttributes
        this.store.append(traceId, {
          name: span.name,
          attributes: enriched,
        })
      }
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
