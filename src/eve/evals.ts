import {
  defineEval,
  type EveEvalContext,
  type EveEvalDefinition,
} from 'eve/evals'
import {
  AgentEvalsClient,
  type AgentEvalsSuite,
  type AgentEvalsTask,
} from '../agentEvals.js'

export interface FabricateEveSuiteSelector {
  id?: string
  name?: string
  version?: number
}

export interface LoadFabricateEveSuiteOptions {
  client: AgentEvalsClient
  projectId: string
  suite: FabricateEveSuiteSelector
}

export interface FabricateEveSuite {
  client: AgentEvalsClient
  suite: AgentEvalsSuite
  tasks: AgentEvalsTask[]
}

export interface CreateFabricateEveEvalsOptions
  extends LoadFabricateEveSuiteOptions {
  /**
   * Materialize the task's effective fixture before the agent turn starts.
   */
  prepareTask?: (
    task: AgentEvalsTask,
    context: FabricateEveSuite,
  ) => void | Promise<void>
  /**
   * Override the default `send` + successful/no-failed-actions assertions.
   */
  test?: (
    context: EveEvalContext,
    task: AgentEvalsTask,
  ) => void | Promise<void>
  metadata?: (task: AgentEvalsTask) => Record<string, unknown>
}

export interface CreateFabricateEveEvalsForAllSuitesOptions {
  client: AgentEvalsClient
  projectId: string
  prepareTask?: (
    task: AgentEvalsTask,
    context: FabricateEveSuite,
  ) => void | Promise<void>
  test?: (
    context: EveEvalContext,
    task: AgentEvalsTask,
  ) => void | Promise<void>
  metadata?: (task: AgentEvalsTask) => Record<string, unknown>
}

/**
 * Returns the latest version of every suite in a project.
 */
export async function listLatestFabricateEveSuites(
  client: AgentEvalsClient,
  projectId: string,
): Promise<AgentEvalsSuite[]> {
  const suites = await client.listSuites(projectId)
  const latestByParent = new Map<string, AgentEvalsSuite>()
  for (const suite of suites) {
    const existing = latestByParent.get(suite.suite_id)
    if (!existing || suite.version > existing.version) {
      latestByParent.set(suite.suite_id, suite)
    }
  }
  return [...latestByParent.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
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
          options.suite.version != null
            ? ` version ${options.suite.version}`
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
 * Loads the latest version of every suite that contains at least one task.
 */
export async function loadAllFabricateEveSuites(options: {
  client: AgentEvalsClient
  projectId: string
}): Promise<FabricateEveSuite[]> {
  const suites = await listLatestFabricateEveSuites(
    options.client,
    options.projectId,
  )
  if (suites.length === 0) {
    throw new Error(
      `No evaluation suites found in project ${options.projectId}.`,
    )
  }

  const loaded: FabricateEveSuite[] = []
  for (const suite of suites) {
    const tasks = await options.client.listTasks(suite.id)
    if (tasks.length === 0) continue
    loaded.push({ client: options.client, suite, tasks })
  }

  if (loaded.length === 0) {
    throw new Error(
      `No evaluation suites with tasks found in project ${options.projectId}.`,
    )
  }

  return loaded
}

function defineFabricateEveEval(
  options: {
    prepareTask?: (
      task: AgentEvalsTask,
      context: FabricateEveSuite,
    ) => void | Promise<void>
    test?: (
      context: EveEvalContext,
      task: AgentEvalsTask,
    ) => void | Promise<void>
    metadata?: (task: AgentEvalsTask) => Record<string, unknown>
  },
  loaded: FabricateEveSuite,
  task: AgentEvalsTask,
): EveEvalDefinition {
  return defineEval({
    description: task.input,
    tags: task.tags,
    metadata: {
      ...options.metadata?.(task),
      agentEvals: {
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
  })
}

/**
 * Creates one native Eve eval per current Fabricate task.
 */
export async function createFabricateEveEvals(
  options: CreateFabricateEveEvalsOptions,
): Promise<EveEvalDefinition[]> {
  const loaded = await loadFabricateEveSuite(options)

  return loaded.tasks.map((task) => defineFabricateEveEval(options, loaded, task))
}

/**
 * Creates one native Eve eval per task in every latest suite version.
 */
export async function createFabricateEveEvalsForAllSuites(
  options: CreateFabricateEveEvalsForAllSuitesOptions,
): Promise<EveEvalDefinition[]> {
  const loadedSuites = await loadAllFabricateEveSuites(options)
  return loadedSuites.flatMap((loaded) =>
    loaded.tasks.map((task) => defineFabricateEveEval(options, loaded, task)),
  )
}
