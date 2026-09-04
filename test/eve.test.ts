import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvalsClient, AgentEvalsTask } from '../src/index.js'
import {
  createFabricateEveEvals,
  createFabricateEveEvalsForAllSuites,
  FabricateEveReporter,
  EveSessionTraceStore,
  fabricateEveSpanProcessors,
} from '../src/eve/index.js'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'fabricate-eve-test-'))
}

function stubSpanProcessor(): SpanProcessor {
  return {
    onStart() {},
    onEnd() {},
    async shutdown() {},
    async forceFlush() {},
  }
}

test('fabricateEveSpanProcessors keeps the Fabricate exporter first', () => {
  const extra = stubSpanProcessor()
  const processors = fabricateEveSpanProcessors({
    additionalSpanProcessors: [extra],
  })

  assert.equal(processors.length, 2)
  assert.equal(processors[1], extra)
})

test('fabricateEveSpanProcessors omits extras when none are provided', () => {
  const processors = fabricateEveSpanProcessors()
  assert.equal(processors.length, 1)
})

test('EveSessionTraceStore reads and clears spans by session', () => {
  const directory = temporaryDirectory()
  try {
    const store = new EveSessionTraceStore({ directory })
    store.indexSession('session-1', 'trace-1')
    store.append('trace-1', {
      name: 'llm.call',
      attributes: { 'openinference.span.kind': 'LLM' },
    })

    assert.deepEqual(store.readSession('session-1'), [
      {
        name: 'llm.call',
        attributes: { 'openinference.span.kind': 'LLM' },
      },
    ])

    store.clearSession('session-1')
    assert.deepEqual(store.readSession('session-1'), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('createFabricateEveEvals loads current tasks and prepares each case', async () => {
  const task: AgentEvalsTask = {
    id: 'task-1',
    suite_id: 'suite-1',
    key: 'lookup-order',
    input: 'Find my order',
    expected_output: null,
    tags: ['orders'],
    input_token_limit: null,
    output_token_limit: null,
    fixture_id: null,
    effective_fixture: null,
  }
  const client = {
    findSuite: async () => ({
      id: 'suite-1',
      project_id: 'project-1',
      suite_id: 'parent-1',
      name: 'Suite',
      version: 1,
      description: null,
      tags: [],
      task_count: 1,
      default_fixture_id: null,
      default_fixture: null,
    }),
    listTasks: async () => [task],
  } as unknown as AgentEvalsClient
  const events: string[] = []

  const evaluations = await createFabricateEveEvals({
    client,
    projectId: 'project-1',
    suite: { id: 'suite-1' },
    prepareTask: async () => {
      events.push('prepare')
    },
    test: async (_context, currentTask) => {
      events.push(`test:${currentTask.key}`)
    },
  })

  assert.equal(evaluations.length, 1)
  assert.deepEqual(evaluations[0].metadata, {
    agentEvals: { suiteId: 'suite-1', key: 'lookup-order' },
  })
  await evaluations[0].test({} as never)
  assert.deepEqual(events, ['prepare', 'test:lookup-order'])
})

test('createFabricateEveEvalsForAllSuites loads every latest suite with tasks', async () => {
  const taskA: AgentEvalsTask = {
    id: 'task-a',
    suite_id: 'suite-a',
    key: 'book-meeting',
    input: '{"prompt":"Book Sue"}',
    expected_output: null,
    tags: [],
    input_token_limit: null,
    output_token_limit: null,
    fixture_id: null,
    effective_fixture: null,
  }
  const taskB: AgentEvalsTask = {
    id: 'task-b',
    suite_id: 'suite-b',
    key: 'confirm-slot',
    input: '{"prompt":"Confirm slot"}',
    expected_output: null,
    tags: [],
    input_token_limit: null,
    output_token_limit: null,
    fixture_id: null,
    effective_fixture: null,
  }
  const client = {
    listSuites: async () => [
      {
        id: 'suite-a',
        project_id: 'project-1',
        suite_id: 'parent-a',
        name: 'Booking',
        version: 2,
        description: null,
        tags: [],
        task_count: 1,
        default_fixture_id: null,
        default_fixture: null,
      },
      {
        id: 'suite-a-old',
        project_id: 'project-1',
        suite_id: 'parent-a',
        name: 'Booking',
        version: 1,
        description: null,
        tags: [],
        task_count: 1,
        default_fixture_id: null,
        default_fixture: null,
      },
      {
        id: 'suite-b',
        project_id: 'project-1',
        suite_id: 'parent-b',
        name: 'Confirmations',
        version: 1,
        description: null,
        tags: [],
        task_count: 1,
        default_fixture_id: null,
        default_fixture: null,
      },
    ],
    listTasks: async (suiteId: string) =>
      suiteId === 'suite-a' ? [taskA] : suiteId === 'suite-b' ? [taskB] : [],
  } as unknown as AgentEvalsClient

  const evaluations = await createFabricateEveEvalsForAllSuites({
    client,
    projectId: 'project-1',
  })

  assert.equal(evaluations.length, 2)
  assert.deepEqual(
    evaluations.map((evaluation) => evaluation.metadata?.agentEvals),
    [
      { suiteId: 'suite-a', key: 'book-meeting' },
      { suiteId: 'suite-b', key: 'confirm-slot' },
    ],
  )
})

test('FabricateEveReporter enriches span attributes before reporting', async () => {
  const directory = temporaryDirectory()
  const calls: Record<string, unknown>[] = []
  try {
    const store = new EveSessionTraceStore({ directory })
    store.indexSession('session-1', 'trace-1')
    store.append('trace-1', {
      name: 'llm.call',
      attributes: {
        'openinference.span.kind': 'LLM',
        'llm.token_count.prompt': 1000,
      },
    })

    const client = {
      createRun: async () => ({ id: 'run-1' }),
      reportTrial: async (_runId: string, input: unknown) => {
        calls.push({ reportTrial: input })
        return { id: 'trial-1' }
      },
      waitForGrading: async () => ({
        id: 'trial-1',
        passed: true,
        grading: { status: 'completed' },
        graders: [],
      }),
      updateRun: async () => ({ id: 'run-1' }),
    } as unknown as AgentEvalsClient
    const reporter = new FabricateEveReporter({
      client,
      projectId: 'project-1',
      directory,
      logger: { log() {}, error() {} },
      enrichSpanAttributes: (attributes) => {
        attributes['llm.cost.total'] = 0.0123
      },
    })

    await reporter.onRunStart(
      [
        {
          id: 'eval-1',
          metadata: {
            agentEvals: { suiteId: 'suite-1', key: 'lookup-order' },
          },
        },
      ],
      { url: 'http://localhost:2000', kind: 'local' },
    )
    await reporter.onEvalComplete({
      id: 'eval-1',
      verdict: 'passed',
      startedAt: '2026-07-17T12:00:00.000Z',
      completedAt: '2026-07-17T12:00:01.250Z',
      result: {
        status: 'completed',
        sessionId: 'session-1',
        derived: {},
      },
    })

    const reported = calls[0]?.reportTrial as {
      transcript: { messages: Array<{ attributes: Record<string, unknown> }> }
    }
    assert.equal(reported.transcript.messages[0]?.attributes['llm.cost.total'], 0.0123)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('FabricateEveReporter reports stored spans and finalizes the run', async () => {
  const directory = temporaryDirectory()
  const calls: Record<string, unknown>[] = []
  try {
    const store = new EveSessionTraceStore({ directory })
    store.indexSession('session-1', 'trace-1')
    store.append('trace-1', {
      name: 'llm.call',
      attributes: { 'openinference.span.kind': 'LLM' },
    })

    const client = {
      createRun: async (_projectId: string, input: unknown) => {
        calls.push({ createRun: input })
        return { id: 'run-1' }
      },
      reportTrial: async (_runId: string, input: unknown) => {
        calls.push({ reportTrial: input })
        return { id: 'trial-1' }
      },
      waitForGrading: async () => ({
        id: 'trial-1',
        passed: true,
        grading: { status: 'completed' },
        graders: [],
      }),
      updateRun: async (_runId: string, input: unknown) => {
        calls.push({ updateRun: input })
        return { id: 'run-1' }
      },
    } as unknown as AgentEvalsClient
    const reporter = new FabricateEveReporter({
      client,
      projectId: 'project-1',
      directory,
      logger: { log() {}, error() {} },
    })

    await reporter.onRunStart(
      [
        {
          id: 'eval-1',
          metadata: {
            agentEvals: { suiteId: 'suite-1', key: 'lookup-order' },
          },
        },
      ],
      { url: 'http://localhost:2000', kind: 'local' },
    )
    await reporter.onEvalComplete({
      id: 'eval-1',
      verdict: 'passed',
      startedAt: '2026-07-17T12:00:00.000Z',
      completedAt: '2026-07-17T12:00:01.250Z',
      result: {
        status: 'completed',
        sessionId: 'session-1',
        derived: {},
      },
    })
    await reporter.onRunComplete({})

    assert.deepEqual(calls[1], {
      reportTrial: {
        task_key: 'lookup-order',
        status: 'completed',
        latency_ms: 1250,
        transcript: {
          messages: [
            {
              name: 'llm.call',
              attributes: { 'openinference.span.kind': 'LLM' },
            },
          ],
        },
        attachment_upload_ids: undefined,
        grade: true,
        graders: undefined,
      },
    })
    assert.deepEqual(calls[2], {
      updateRun: { status: 'completed' },
    })
    assert.deepEqual(store.readSession('session-1'), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('FabricateEveReporter creates one Fabricate run per suite', async () => {
  const directory = temporaryDirectory()
  const calls: Record<string, unknown>[] = []
  try {
    const store = new EveSessionTraceStore({ directory })
    store.indexSession('session-a', 'trace-a')
    store.append('trace-a', {
      name: 'llm.call',
      attributes: { 'openinference.span.kind': 'LLM' },
    })
    store.indexSession('session-b', 'trace-b')
    store.append('trace-b', {
      name: 'tool.call',
      attributes: { 'openinference.span.kind': 'TOOL' },
    })

    let runCounter = 0
    const client = {
      createRun: async (_projectId: string, input: unknown) => {
        calls.push({ createRun: input })
        runCounter += 1
        return { id: `run-${runCounter}` }
      },
      reportTrial: async (runId: string, input: unknown) => {
        calls.push({ reportTrial: { runId, input } })
        return { id: `trial-${runId}` }
      },
      waitForGrading: async () => ({
        id: 'trial',
        passed: true,
        grading: { status: 'completed' },
        graders: [],
      }),
      updateRun: async (runId: string, input: unknown) => {
        calls.push({ updateRun: { runId, input } })
        return { id: runId }
      },
    } as unknown as AgentEvalsClient
    const reporter = new FabricateEveReporter({
      client,
      projectId: 'project-1',
      directory,
      logger: { log() {}, error() {} },
    })

    await reporter.onRunStart(
      [
        {
          id: 'eval-a',
          metadata: {
            agentEvals: { suiteId: 'suite-a', key: 'book-meeting' },
          },
        },
        {
          id: 'eval-b',
          metadata: {
            agentEvals: { suiteId: 'suite-b', key: 'confirm-slot' },
          },
        },
      ],
      { url: 'http://localhost:2000', kind: 'local' },
    )
    await reporter.onEvalComplete({
      id: 'eval-a',
      verdict: 'passed',
      startedAt: '2026-07-17T12:00:00.000Z',
      completedAt: '2026-07-17T12:00:01.000Z',
      result: {
        status: 'completed',
        sessionId: 'session-a',
        derived: {},
      },
    })
    await reporter.onEvalComplete({
      id: 'eval-b',
      verdict: 'passed',
      startedAt: '2026-07-17T12:00:00.000Z',
      completedAt: '2026-07-17T12:00:02.000Z',
      result: {
        status: 'completed',
        sessionId: 'session-b',
        derived: {},
      },
    })
    await reporter.onRunComplete({})

    assert.equal(
      calls.filter((call) => 'createRun' in call).length,
      2,
    )
    assert.deepEqual(
      calls
        .filter((call) => 'createRun' in call)
        .map((call) => (call as { createRun: { suite_id: string } }).createRun.suite_id),
      ['suite-a', 'suite-b'],
    )
    assert.equal(
      calls.filter((call) => 'updateRun' in call).length,
      2,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
