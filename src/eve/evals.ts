import {
  defineEval,
  type EveEvalContext,
  type EveEvalDefinition,
} from 'eve/evals'
import {
  AgentTestingClient,
  type AgentTestingSuite,
  type AgentTestingTask,
} from '../agentTesting.js'

export interface FabricateEveSuiteSelector {
  id?: string
  name?: string
  versionTag?: string
}

export interface LoadFabricateEveSuiteOptions {
  client: AgentTestingClient
  projectId: string
  suite: FabricateEveSuiteSelector
}

export interface FabricateEveSuite {
  client: AgentTestingClient
  suite: AgentTestingSuite
  tasks: AgentTestingTask[]
}

export interface CreateFabricateEveEvalsOptions
  extends LoadFabricateEveSuiteOptions {
  /**
   * Materialize the task's effective fixture before the agent turn starts.
   */
  prepareTask?: (
    task: AgentTestingTask,
    context: FabricateEveSuite,
  ) => void | Promise<void>
  /**
   * Override the default `send` + successful/no-failed-actions assertions.
   */
  test?: (
    context: EveEvalContext,
    task: AgentTestingTask,
  ) => void | Promise<void>
  metadata?: (task: AgentTestingTask) => Record<string, unknown>
}

/**
 * Finds one existing Fabricate suite and loads its current task definitions.
 */
export async function loadFabricateEveSuite(
  options: LoadFabricateEveSuiteOptions,
): Promise<FabricateEveSuite> {
  const suite = await options.client.findSuite(options.projectId, options.suite)
  if (!suite) {
    const selector = options.suite.id
      ? `id ${options.suite.id}`
      : `name "${options.suite.name ?? ''}"${
          options.suite.versionTag
            ? ` version "${options.suite.versionTag}"`
            : ''
        }`
    throw new Error(
      `Could not find Fabricate evaluation suite with ${selector} in project ${options.projectId}.`,
    )
  }

  const tasks = await options.client.listTasks(suite.id)
  if (tasks.length === 0) {
    throw new Error(
      `Fabricate evaluation suite "${suite.name}" (${suite.id}) contains no tasks.`,
    )
  }

  return { client: options.client, suite, tasks }
}

/**
 * Creates one native Eve eval per current Fabricate task.
 */
export async function createFabricateEveEvals(
  options: CreateFabricateEveEvalsOptions,
): Promise<EveEvalDefinition[]> {
  const loaded = await loadFabricateEveSuite(options)

  return loaded.tasks.map((task) =>
    defineEval({
      description: task.input,
      tags: task.tags,
      metadata: {
        ...options.metadata?.(task),
        agentTesting: {
          suiteId: loaded.suite.id,
          key: task.key,
        },
      },
      async test(context) {
        await options.prepareTask?.(task, loaded)
        if (options.test) {
          await options.test(context, task)
          return
        }

        await context.send(task.input)
        context.succeeded()
        context.noFailedActions()
      },
    }),
  )
}
