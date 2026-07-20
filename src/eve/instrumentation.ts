import {
  isOpenInferenceSpan,
  OpenInferenceSimpleSpanProcessor,
} from '@arizeai/openinference-vercel'
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
}

/**
 * Creates the default export for an Eve `agent/instrumentation.ts` file.
 */
export function createFabricateEveInstrumentation(
  options: FabricateEveInstrumentationOptions = {},
): InstrumentationDefinition {
  const {
    recordInputs = true,
    recordOutputs = true,
    ...exporterOptions
  } = options

  return defineInstrumentation({
    setup: ({ agentName }) =>
      registerOTel({
        serviceName: agentName,
        spanProcessors: [
          new OpenInferenceSimpleSpanProcessor({
            exporter: new EveSessionFileSpanExporter(exporterOptions),
            spanFilter: isOpenInferenceSpan,
            reparentOrphanedSpans: true,
          }),
        ],
      }),
    recordInputs,
    recordOutputs,
  })
}
