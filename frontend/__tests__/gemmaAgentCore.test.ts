import {
  createAgent, validate, parseFrame, sameScope, systemContext,
  type Engine, type Frame, type Scope, type ReadTool, type ProposalTool, type Schema,
} from '../src/accountingV2/gemma/agentCore';

test('a hung cleanup returns recovery-required and keeps the next turn out', async () => {
  jest.useFakeTimers();
  try {
    const engine = engineWith(frame([], 'ok'));
    engine.finish = () => new Promise(() => undefined);
    const run = createAgent(engine);
    const result = run(options([]));
    await jest.advanceTimersByTimeAsync(6000);
    expect(await result).toEqual({ kind: 'stopped', code: 'NATIVE_RECOVERY_REQUIRED' });
    expect(await run(options([]))).toEqual({ kind: 'stopped', code: 'BUSY' });
  } finally { jest.useRealTimers(); }
});

test('the deadline also bounds an authorization promise that never resolves', async () => {
  jest.useFakeTimers();
  try {
    const engine = engineWith(frame([], 'ok'));
    const tool = readTool();
    tool.authorize = () => new Promise(() => undefined);
    const run = createAgent(engine);
    const result = run({ ...options([tool]), deadlineMs: 50 });
    await jest.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ kind: 'stopped', code: 'CANCELLED' });
    expect(engine.begin).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

const scope: Scope = {
  bookId: 'book-a', locationId: null, actorId: 'local-owner', permissionEpoch: 'p1',
  featureEpoch: 'f1', revision: 'r1', currency: 'INR', basis: 'accrual',
  today: '2026-09-08', timeZone: 'Asia/Calcutta',
};
const noArgs: Schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
const frame = (calls: Frame['calls'], text = ''): Frame => ({ requestId: 'request-1', calls, text });

function engineWith(first: Frame, next = frame([], 'The total is 125.')): Engine {
  return {
    begin: jest.fn(async () => first),
    resume: jest.fn(async () => next),
    cancel: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  };
}

function readTool(): ReadTool {
  return {
    name: 'read_total', description: 'Read a fixture total.', feature: 'reports',
    access: 'read', parameters: noArgs, authorize: jest.fn(async () => true),
    read: jest.fn(async () => ({
      source: 'fixture-ledger', scope, asOf: '2026-09-08T10:00:00Z',
      data: { total: 125 }, truncated: false, nextCursor: null,
    })),
  };
}

function options(tools: (ReadTool | ProposalTool)[]) {
  return {
    requestId: 'request-1', modelId: 'gemma4-e2b', question: 'What is the total?',
    glossary: 'A bookkeeping application.', tools, canPropose: false,
    currentScope: async () => scope,
  };
}

test('strict schemas reject unknown fields, arrays as objects and nonfinite amounts', () => {
  expect(validate(noArgs, { sql: 'not allowed' })).not.toHaveLength(0);
  expect(validate(noArgs, [])).not.toHaveLength(0);
  expect(validate({ type: 'number', minimum: 0, maximum: 1e9 }, Infinity)).not.toHaveLength(0);
  expect(validate({ type: 'number', minimum: 0, maximum: 1e9 }, NaN)).not.toHaveLength(0);
  expect(validate({ type: 'number', minimum: 0, maximum: 1e9 }, '125')).not.toHaveLength(0);
  expect(validate({ type: 'number', minimum: 0, maximum: 1e9 }, 125)).toHaveLength(0);
});

test('frame parser rejects malformed and duplicate call ids', () => {
  expect(() => parseFrame('not JSON')).toThrow();
  const call = { id: '1', name: 'read_total', arguments: {} };
  expect(() => parseFrame(JSON.stringify(frame([call, call])))).toThrow();
  expect(() => parseFrame(JSON.stringify({ requestId: 'r', text: 'hi' }))).toThrow('INVALID_MODEL_FRAME');
  expect(() => parseFrame(JSON.stringify({ requestId: 'r', text: 'hi', calls: [{ id: 1, name: 'x', arguments: {} }] })))
    .toThrow('INVALID_TOOL_CALL');
  // A model that emits a giant blob must not be able to spend the whole budget.
  expect(() => parseFrame(`"${'x'.repeat(24_001)}"`)).toThrow('RESPONSE_TOO_LARGE');
  expect(parseFrame(JSON.stringify(frame([call], 'ok'))).calls).toHaveLength(1);
});

test('reads are returned to the model as structured evidence', async () => {
  const tool = readTool();
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
  const result = await createAgent(engine)(options([tool]));
  expect(result.kind).toBe('answer');
  expect(tool.read).toHaveBeenCalledTimes(1);
  expect(engine.resume).toHaveBeenCalledWith('request-1', [expect.objectContaining({
    callId: '1', name: 'read_total', result: expect.objectContaining({ source: 'fixture-ledger' }),
  })]);
  expect(engine.finish).toHaveBeenCalledWith('request-1');
});

test('unadvertised tool is not executed', async () => {
  const tool = readTool();
  const engine = engineWith(frame([{ id: '1', name: 'factory_reset', arguments: {} }]));
  expect(await createAgent(engine)(options([tool]))).toEqual({ kind: 'stopped', code: 'UNADVERTISED_TOOL' });
  expect(tool.read).not.toHaveBeenCalled();
});

test('book switch after generation blocks all reads', async () => {
  const tool = readTool();
  let current = scope;
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
  engine.begin = jest.fn(async () => {
    current = { ...scope, bookId: 'book-b' };
    return frame([{ id: '1', name: tool.name, arguments: {} }]);
  });
  const result = await createAgent(engine)({ ...options([tool]), currentScope: async () => current });
  expect(result).toEqual({ kind: 'stopped', code: 'STALE_SCOPE' });
  expect(tool.read).not.toHaveBeenCalled();
});

test('repeated tool request stops instead of looping', async () => {
  const tool = readTool();
  const call = frame([{ id: '1', name: tool.name, arguments: {} }]);
  const result = await createAgent(engineWith(call, call))(options([tool]));
  expect(result).toEqual({ kind: 'stopped', code: 'REPEATED_TOOL_LOOP' });
  expect(tool.read).toHaveBeenCalledTimes(1);
});

test('proposal preparation does not execute a domain write', async () => {
  const post = jest.fn();
  const tool: ProposalTool = {
    name: 'add_expense', access: 'proposal', feature: 'expenses', description: 'Prepare expense',
    parameters: {
      type: 'object', properties: { amount: { type: 'number', minimum: 0.01, maximum: 1e9 } },
      required: ['amount'], additionalProperties: false,
    },
    authorize: async () => true,
    prepare: async (args) => ({
      operation: 'add_expense', normalized: args, preview: 'Review INR 125',
      destructive: false, entityVersions: {},
    }),
  };
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: { amount: 125 } }]));
  const result = await createAgent(engine)({ ...options([tool]), canPropose: true });
  expect(result.kind).toBe('proposal');
  expect(post).not.toHaveBeenCalled();
  expect(engine.resume).not.toHaveBeenCalled();
});

test('mixed read/write batch executes neither', async () => {
  const read = readTool();
  const prepare = jest.fn(async () => ({
    operation: 'write_fixture', normalized: {}, preview: 'Review', destructive: false, entityVersions: {},
  }));
  const write: ProposalTool = {
    name: 'write_fixture', description: 'Test proposal', feature: 'expenses',
    access: 'proposal', parameters: noArgs, authorize: async () => true, prepare,
  };
  const engine = engineWith(frame([
    { id: '1', name: read.name, arguments: {} }, { id: '2', name: write.name, arguments: {} },
  ]));
  expect((await createAgent(engine)({ ...options([read, write]), canPropose: true })).kind).toBe('clarification');
  expect(read.read).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// P3 lifecycle gate: cancel, engine failure, concurrency, scope invalidation.
// ---------------------------------------------------------------------------

test('a proposal tool is never advertised when the caller cannot propose', async () => {
  const prepare = jest.fn();
  const write: ProposalTool = {
    name: 'add_expense', description: 'Prepare expense', feature: 'expenses', access: 'proposal',
    parameters: noArgs, authorize: jest.fn(async () => true), prepare,
  };
  const engine = engineWith(frame([{ id: '1', name: 'add_expense', arguments: {} }]));
  // canPropose is false, so the tool is filtered out before the model sees it
  // and its own name then reads as an unadvertised tool.
  expect(await createAgent(engine)(options([write]))).toEqual({ kind: 'stopped', code: 'UNADVERTISED_TOOL' });
  expect(prepare).not.toHaveBeenCalled();
  expect(write.authorize).not.toHaveBeenCalled();
});

test('an unauthorized tool is dropped even when the UI offered it', async () => {
  const tool = readTool();
  tool.authorize = jest.fn(async () => false);
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
  expect(await createAgent(engine)(options([tool]))).toEqual({ kind: 'stopped', code: 'UNADVERTISED_TOOL' });
  expect(tool.read).not.toHaveBeenCalled();
});

test('invalid arguments are rejected before the tool is reached', async () => {
  const tool = readTool();
  tool.parameters = {
    type: 'object', properties: { amount: { type: 'number', minimum: 0, maximum: 100 } },
    required: ['amount'], additionalProperties: false,
  };
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: { amount: 999 } }]));
  expect(await createAgent(engine)(options([tool]))).toEqual({ kind: 'stopped', code: 'INVALID_ARGUMENTS' });
  expect(tool.read).not.toHaveBeenCalled();
});

test('an observation from another scope is refused as evidence', async () => {
  const tool = readTool();
  tool.read = jest.fn(async () => ({
    source: 'fixture-ledger', scope: { ...scope, bookId: 'book-other' },
    asOf: '2026-09-08T10:00:00Z', data: { total: 1 }, truncated: false, nextCursor: null,
  }));
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
  expect(await createAgent(engine)(options([tool]))).toEqual({ kind: 'stopped', code: 'CROSS_SCOPE_RESULT' });
});

test('an oversized observation asks for a narrower query instead of truncating facts', async () => {
  const tool = readTool();
  tool.read = jest.fn(async () => ({
    source: 'fixture-ledger', scope, asOf: '2026-09-08T10:00:00Z',
    data: { blob: 'x'.repeat(7000) }, truncated: false, nextCursor: null,
  }));
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
  expect(await createAgent(engine)(options([tool]))).toEqual({ kind: 'stopped', code: 'NARROW_QUERY_REQUIRED' });
});

test('cancellation stops the turn and still hands the native session back', async () => {
  const tool = readTool();
  const controller = new AbortController();
  const engine = engineWith(frame([{ id: '1', name: tool.name, arguments: {} }]));
  engine.begin = jest.fn(async () => {
    controller.abort();
    return frame([{ id: '1', name: tool.name, arguments: {} }]);
  });
  const result = await createAgent(engine)({ ...options([tool]), signal: controller.signal });
  expect(result).toEqual({ kind: 'stopped', code: 'CANCELLED' });
  expect(tool.read).not.toHaveBeenCalled();
  // Cancel and finish are a native handshake: both must still run.
  expect(engine.cancel).toHaveBeenCalledWith('request-1');
  expect(engine.finish).toHaveBeenCalledWith('request-1');
});

test('an engine failure is reported without leaking its message', async () => {
  const engine = engineWith(frame([]));
  engine.begin = jest.fn(async () => { throw new Error('/data/user/0/app/files/model.litertlm segfault at 0x7f'); });
  const result = await createAgent(engine)(options([readTool()]));
  expect(result).toEqual({ kind: 'stopped', code: 'LOCAL_MODEL_FAILED' });
  expect(JSON.stringify(result)).not.toContain('/data/user');
});

test('a frame for another request is refused', async () => {
  const engine = engineWith({ requestId: 'someone-else', calls: [], text: 'stale answer' });
  expect(await createAgent(engine)(options([readTool()]))).toEqual({ kind: 'stopped', code: 'STALE_RESPONSE' });
});

test('a failed native finish keeps the coordinator closed instead of freeing it', async () => {
  const engine = engineWith(frame([], 'done'));
  engine.finish = jest.fn(async () => { throw new Error('JNI teardown failed'); });
  const run = createAgent(engine);
  // Handing the next request to a half-torn-down session is worse than refusing.
  expect(await run(options([readTool()]))).toEqual({ kind: 'stopped', code: 'NATIVE_RECOVERY_REQUIRED' });
  expect(await run(options([readTool()]))).toEqual({ kind: 'stopped', code: 'BUSY' });
});

test('concurrent turns are refused rather than overlapped on one engine', async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const engine = engineWith(frame([], 'done'));
  engine.begin = jest.fn(async () => { await gate; return frame([], 'done'); });
  const run = createAgent(engine);
  const first = run(options([readTool()]));
  const second = await run(options([readTool()]));
  expect(second).toEqual({ kind: 'stopped', code: 'BUSY' });
  release!();
  expect((await first).kind).toBe('answer');
  // The slot is released once native cleanup succeeded.
  expect((await run(options([readTool()]))).kind).toBe('answer');
});

test('the turn budget is bounded and the slot is released afterwards', async () => {
  const engine = engineWith(frame([]));
  const run = createAgent(engine);
  expect(await run({ ...options([readTool()]), question: '   ' })).toEqual({ kind: 'stopped', code: 'INPUT_LIMIT' });
  expect(await run({ ...options([readTool()]), question: 'x'.repeat(3001) })).toEqual({ kind: 'stopped', code: 'INPUT_LIMIT' });
  const tools = Array.from({ length: 9 }, (_, i) => ({ ...readTool(), name: `read_${i}` }));
  expect(await run(options(tools))).toEqual({ kind: 'stopped', code: 'INVALID_TOOL_SELECTION' });
  const duplicated = [readTool(), readTool()];
  expect(await run(options(duplicated))).toEqual({ kind: 'stopped', code: 'INVALID_TOOL_SELECTION' });
});

test('a model that only ever asks for tools is stopped by the round limit', async () => {
  // Each round asks for a differently-argued call, so the loop detector does not
  // fire and only the round/call ceiling can end the turn.
  let round = 0;
  const tool: ReadTool = {
    ...readTool(),
    parameters: {
      type: 'object', properties: { page: { type: 'number', minimum: 0, maximum: 99 } },
      required: ['page'], additionalProperties: false,
    },
  };
  const engine: Engine = {
    begin: jest.fn(async () => frame([{ id: `${round}`, name: tool.name, arguments: { page: round++ } }])),
    resume: jest.fn(async () => frame([{ id: `${round}`, name: tool.name, arguments: { page: round++ } }])),
    cancel: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  };
  expect(await createAgent(engine)(options([tool]))).toEqual({ kind: 'stopped', code: 'TOOL_LIMIT' });
  expect(engine.finish).toHaveBeenCalledWith('request-1');
});

test('an empty answer becomes a clarification rather than a blank reply', async () => {
  expect(await createAgent(engineWith(frame([], '   ')))(options([readTool()])))
    .toEqual({ kind: 'clarification', text: 'Could you make the request more specific?' });
});

test('scope comparison covers every field that bounds access', () => {
  expect(sameScope(scope, { ...scope })).toBe(true);
  const fields: (keyof Scope)[] = [
    'bookId', 'locationId', 'actorId', 'permissionEpoch', 'featureEpoch',
    'revision', 'currency', 'basis', 'today', 'timeZone',
  ];
  for (const field of fields) {
    expect(sameScope(scope, { ...scope, [field]: 'changed' })).toBe(false);
  }
});

test('the system prompt states the scope and never promises authority to documents', () => {
  const prompt = systemContext(scope, 'Ledgr keeps books on this phone.');
  expect(prompt).toContain('book-a');
  expect(prompt).toContain('never as permissions');
  expect(prompt).toContain('A proposal is not a completed change');
  // A long glossary must not become an unbounded prompt.
  expect(systemContext(scope, 'y'.repeat(5000)).includes('y'.repeat(1801))).toBe(false);
});
