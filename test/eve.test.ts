import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentEvalsClient, AgentEvalsTask } from '../src/index.js'
import {
  createFabricateEveEvals,
  FabricateEveReporter,
  EveSessionTraceStore,
} from '../src/eve/index.js'

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'fabricate-eve-test-'))
}

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
