import {
  isOpenInferenceSpan,
  OpenInferenceSimpleSpanProcessor,
} from '@arizeai/openinference-vercel'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { registerOTel } from '@vercel/otel'
import {
  defineInstrumentation,
  type InstrumentationDefinition,
} from 'eve/instrumentation'
import {
  EveSessionFileSpanExporter,
  type EveSessionFileSpanExporterOptions,
} from './traceStore.js'

export interface FabricateEveInstrumentationOptions
  extends EveSessionFileSpanExporterOptions {
  recordInputs?: boolean
  recordOutputs?: boolean
  /**
   * Extra processors registered on the same tracer provider as the Fabricate
   * OpenInference file exporter. Use this to fan traces out to a second
   * backend without replacing Fabricate eval persistence.
   */
  additionalSpanProcessors?: SpanProcessor[]
}

/**
 * Builds the processor list used by `createFabricateEveInstrumentation`.
 * The Fabricate OpenInference exporter is always first so eval reporting
 * keeps working when callers add extra destinations.
 */
export function fabricateEveSpanProcessors(
  options: FabricateEveInstrumentationOptions = {},
): SpanProcessor[] {
  const {
    recordInputs: _recordInputs,
    recordOutputs: _recordOutputs,
    additionalSpanProcessors = [],
    ...exporterOptions
  } = options

  return [
    new OpenInferenceSimpleSpanProcessor({
      exporter: new EveSessionFileSpanExporter(exporterOptions),
      spanFilter: isOpenInferenceSpan,
      reparentOrphanedSpans: true,
    }),
    ...additionalSpanProcessors,
  ]
}

/**
 * Creates the default export for an Eve `agent/instrumentation.ts` file.
 */
export function createFabricateEveInstrumentation(
  options: FabricateEveInstrumentationOptions = {},
): InstrumentationDefinition {
  const { recordInputs = true, recordOutputs = true } = options

  return defineInstrumentation({
    setup: ({ agentName }) =>
      registerOTel({
        serviceName: agentName,
        spanProcessors: fabricateEveSpanProcessors(options),
      }),
    recordInputs,
    recordOutputs,
  })
}
