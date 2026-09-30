// ── TriRLC Sync Engine Tests ──
// 17 test cases per CTO sync-engine-design.md §7.
// Runner: node --import tsx --test test/sync-engine.test.ts

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { syncSessionToTriMMC, syncPendingSessions, buildSyncPayload } from '../src/sync/index.js';
import type { SyncEngineDeps, SyncMessageInput } from '../src/sync/index.js';
import type { SessionRecord, SyncStatus } from '../src/session-store/types.js';
import type { SyncRequestPayload, SyncSuccessResponse, SyncConflictResponse } from '../src/sync/types.js';
import { DEFAULT_SYNC_CONFIG } from '../src/sync/types.js';

// ── Test helpers ──

/** Mutable fetch handler reference for per-test mocking */
let fetchHandler: (url: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * JSON Response helper — creates a fetch Response with JSON body.
 */
function jsonRes(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * In-memory store mock implementing SyncEngineDeps['store'].
 */
function createMockStore(opts?: {
  sessions?: Array<Partial<SessionRecord> & { id: string; syncStatus?: SyncStatus }>;
  messages?: Record<string, SyncMessageInput[]>;
}) {
  const sessions = new Map<string, SessionRecord>();
  const msgs = new Map<string, SyncMessageInput[]>();

  // Default session factory
  const defaultSession: SessionRecord = {
    id: '',
    status: 'active',
    model: 'test-model',
    systemPrompt: '',
    cwd: '/tmp',
    messageCount: 0,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T01:00:00.000Z',
    closedAt: null,
    title: 'Test Session',
    syncStatus: 'pending',
    lastSyncedAt: null,
    cloudSessionId: null,
  };

  if (opts?.sessions) {
    for (const s of opts.sessions) {
      sessions.set(s.id, { ...defaultSession, ...s } as SessionRecord);
    }
  }
  if (opts?.messages) {
    for (const [id, m] of Object.entries(opts.messages)) {
      msgs.set(id, m);
    }
  }

  const store = {
    getSession(id: string): SessionRecord | null {
      return sessions.get(id) ?? null;
    },
    getMessages(sessionId: string): SyncMessageInput[] {
      return msgs.get(sessionId) ?? [];
    },
    updateSyncStatus(id: string, syncStatus: string, cloudSessionId?: string | null): void {
      const s = sessions.get(id);
      if (s) {
        s.syncStatus = syncStatus as SyncStatus;
        if (syncStatus === 'synced') {
          s.lastSyncedAt = new Date().toISOString();
          if (cloudSessionId !== undefined) s.cloudSessionId = cloudSessionId ?? null;
        }
      }
    },
    getPendingSyncSessions(limit = 50): SessionRecord[] {
      return [...sessions.values()]
        .filter((s) => s.syncStatus === 'pending')
        .slice(0, limit);
    },

    // Test helpers
    _addSession(s: SessionRecord) { sessions.set(s.id, s); },
    _addMessages(sessionId: string, m: SyncMessageInput[]) { msgs.set(sessionId, m); },
    _getSession(id: string) { return sessions.get(id); },
  };

  return store;
}

function makeDeps(store: ReturnType<typeof createMockStore>): SyncEngineDeps {
  return {
    store: {
      getSession: (id) => store.getSession(id),
      getMessages: (id) => store.getMessages(id),
      updateSyncStatus: (id, status, cid) => store.updateSyncStatus(id, status, cid),
      getPendingSyncSessions: (limit) => store.getPendingSyncSessions(limit),
    },
    config: {
      trimcBaseUrl: 'http://127.0.0.1:8710',
      nodeId: 'test-node-1',
      maxMessages: 5000,
      timeoutMs: 5000, // short timeout for tests
      retryBackoffs: [10, 20, 40], // short backoffs for tests
    },
  };
}

function makeMsg(overrides?: Partial<SyncMessageInput>): SyncMessageInput {
  return {
    role: 'user',
    content: 'Hello',
    toolCalls: null,
    toolCallId: null,
    createdAt: '2026-07-22T01:00:00.000Z',
    ...overrides,
  };
}

// ── Test suite ──

describe('sync-engine', () => {
  beforeEach(() => {
    // Default fetch handler — test-specific handlers replace this
    fetchHandler = async () => jsonRes(200, {
      ok: true,
      cloudSessionId: 'cloud-default',
      localSessionId: 'sess-default',
      syncedMessageCount: 0,
      syncedAt: new Date().toISOString(),
    });
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      return fetchHandler(url, init);
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  // ═══ T01: 正常同步 ═══
  it('T01: normal sync — pending session with 10 messages → synced', async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t01', syncStatus: 'pending' }],
      messages: { 'sess-t01': Array.from({ length: 10 }, (_, i) => makeMsg({ content: `msg-${i}` })) },
    });

    fetchHandler = async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as SyncRequestPayload;
      return jsonRes(200, {
        ok: true,
        cloudSessionId: 'cloud-t01',
        localSessionId: body.session.localSessionId,
        syncedMessageCount: 10,
        syncedAt: new Date().toISOString(),
      } satisfies SyncSuccessResponse);
    };

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t01', deps);

    assert.equal(result.ok, true);
    assert.equal(result.cloudSessionId, 'cloud-t01');
    assert.equal(result.syncedMessageCount, 10);
    assert.equal(store._getSession('sess-t01')!.syncStatus, 'synced');
    assert.equal(store._getSession('sess-t01')!.cloudSessionId, 'cloud-t01');
  });

  // ═══ T02: 409 去重 ═══
  it('T02: 409 dedup — TriMMC returns 409 → synced with existingCloudSessionId', async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t02', syncStatus: 'pending' }],
      messages: { 'sess-t02': [makeMsg()] },
    });

    fetchHandler = async () => jsonRes(409, {
      ok: false,
      error: 'duplicate_session',
      message: 'Session already exists',
      existingCloudSessionId: 'cloud-existing-02',
    } satisfies SyncConflictResponse);

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t02', deps);

    assert.equal(result.ok, true);
    assert.equal(result.cloudSessionId, 'cloud-existing-02');
    assert.equal(store._getSession('sess-t02')!.syncStatus, 'synced');
    assert.equal(store._getSession('sess-t02')!.cloudSessionId, 'cloud-existing-02');
  });

  // ═══ T03: 503 重试成功 ═══
  it('T03: 503 retry success — first 503, second 200 → synced + retried', async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t03', syncStatus: 'pending' }],
      messages: { 'sess-t03': [makeMsg()] },
    });

    let callCount = 0;
    fetchHandler = async (_url, init) => {
      callCount++;
      if (callCount === 1) {
        return jsonRes(503, { ok: false, error: 'service_unavailable', message: 'Try later' });
      }
      const body = JSON.parse((init as RequestInit).body as string) as SyncRequestPayload;
      return jsonRes(200, {
        ok: true,
        cloudSessionId: 'cloud-t03',
        localSessionId: body.session.localSessionId,
        syncedMessageCount: 1,
        syncedAt: new Date().toISOString(),
      } satisfies SyncSuccessResponse);
    };

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t03', deps);

    assert.equal(result.ok, true);
    assert.equal(result.retried, true);
    assert.equal(callCount, 2);
    assert.equal(store._getSession('sess-t03')!.syncStatus, 'synced');
  });

  // ═══ T04: 全部重试耗尽 ═══
  it('T04: all retries exhausted — always 503 → error', async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t04', syncStatus: 'pending' }],
      messages: { 'sess-t04': [makeMsg()] },
    });

    fetchHandler = async () => jsonRes(503, { ok: false, error: 'service_unavailable', message: 'Down' });

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t04', deps);

    assert.equal(result.ok, false);
    assert.equal(result.retried, true);
    assert.ok(result.error?.includes('503'));
    assert.equal(store._getSession('sess-t04')!.syncStatus, 'error');
  });

  // ═══ T05: syncing 状态拒绝 ═══
  it("T05: sync_status='syncing' rejected — error='already_syncing'", async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t05', syncStatus: 'syncing' }],
    });

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t05', deps);

    assert.equal(result.ok, false);
    assert.equal(result.error, 'already_syncing');
    assert.equal(store._getSession('sess-t05')!.syncStatus, 'syncing'); // unchanged
  });

  // ═══ T06: local 状态跳过 ═══
  it("T06: sync_status='local' skipped — ok=true, syncedMessageCount=0", async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t06', syncStatus: 'local' }],
    });

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t06', deps);

    assert.equal(result.ok, true);
    assert.equal(result.syncedMessageCount, 0);
    assert.equal(store._getSession('sess-t06')!.syncStatus, 'local'); // unchanged
  });

  // ═══ T07: synced 状态跳过 ═══
  it("T07: sync_status='synced' skipped — ok=true, status unchanged", async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t07', syncStatus: 'synced', cloudSessionId: 'cloud-07' }],
    });

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t07', deps);

    assert.equal(result.ok, true);
    assert.equal(result.cloudSessionId, 'cloud-07');
    assert.equal(store._getSession('sess-t07')!.syncStatus, 'synced');
  });

  // ═══ T08: 消息超 5000 截断 ═══
  it('T08: >5000 messages truncated — payload capped at 5000, truncated=true', () => {
    const session: SessionRecord = {
      id: 'sess-t08',
      status: 'active',
      model: 'test',
      systemPrompt: '',
      cwd: '/tmp',
      messageCount: 6000,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T01:00:00.000Z',
      closedAt: null,
    };

    const messages: SyncMessageInput[] = Array.from({ length: 6000 }, (_, i) => makeMsg({ content: `msg-${i}` }));

    const { payload, truncated } = buildSyncPayload(session, messages, 'test-node', 5000);

    assert.equal(truncated, true);
    assert.equal(payload.session.messages.length, 5000);
    assert.equal(payload.nodeId, 'test-node');
    assert.equal(payload.session.localSessionId, 'sess-t08');
  });

  // ═══ T09: 空消息列表 ═══
  it('T09: empty messages — synced, syncedMessageCount=0', async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t09', syncStatus: 'pending' }],
      messages: { 'sess-t09': [] },
    });

    fetchHandler = async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as SyncRequestPayload;
      return jsonRes(200, {
        ok: true,
        cloudSessionId: 'cloud-t09',
        localSessionId: body.session.localSessionId,
        syncedMessageCount: 0,
        syncedAt: new Date().toISOString(),
      } satisfies SyncSuccessResponse);
    };

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t09', deps);

    assert.equal(result.ok, true);
    assert.equal(result.syncedMessageCount, 0);
    assert.equal(store._getSession('sess-t09')!.syncStatus, 'synced');
  });

  // ═══ T10: 会话不存在 ═══
  it("T10: session not found — error='session_not_found'", async () => {
    const store = createMockStore();

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('nonexistent', deps);

    assert.equal(result.ok, false);
    assert.equal(result.error, 'session_not_found');
  });

  // ═══ T11: 网络超时重试 ═══
  it('T11: timeout retry — AbortError → retry → success', async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t11', syncStatus: 'pending' }],
      messages: { 'sess-t11': [makeMsg()] },
    });

    let callCount = 0;
    fetchHandler = async (_url, init) => {
      callCount++;
      if (callCount === 1) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const body = JSON.parse((init as RequestInit).body as string) as SyncRequestPayload;
      return jsonRes(200, {
        ok: true,
        cloudSessionId: 'cloud-t11',
        localSessionId: body.session.localSessionId,
        syncedMessageCount: 1,
        syncedAt: new Date().toISOString(),
      } satisfies SyncSuccessResponse);
    };

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t11', deps);

    assert.equal(result.ok, true);
    assert.equal(result.retried, true);
    assert.equal(callCount, 2);
    assert.equal(store._getSession('sess-t11')!.syncStatus, 'synced');
  });

  // ═══ T12: 不可重试 4xx（400）═══
  it('T12: non-retryable 4xx (400) — no retry, direct error', async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t12', syncStatus: 'pending' }],
      messages: { 'sess-t12': [makeMsg()] },
    });

    let callCount = 0;
    fetchHandler = async () => {
      callCount++;
      return jsonRes(400, { ok: false, error: 'bad_request', message: 'Invalid payload' });
    };

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t12', deps);

    assert.equal(result.ok, false);
    assert.equal(callCount, 1); // no retry — 400 is non-retryable
    assert.equal(store._getSession('sess-t12')!.syncStatus, 'error');
  });

  // ═══ T13: 批量同步（3 pending）═══
  it('T13: batch sync — 3 pending sessions all succeed', async () => {
    const store = createMockStore({
      sessions: [
        { id: 'sess-b1', syncStatus: 'pending' },
        { id: 'sess-b2', syncStatus: 'pending' },
        { id: 'sess-b3', syncStatus: 'pending' },
      ],
      messages: {
        'sess-b1': [makeMsg({ content: 'a' })],
        'sess-b2': [makeMsg({ content: 'b' })],
        'sess-b3': [makeMsg({ content: 'c' })],
      },
    });

    fetchHandler = async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as SyncRequestPayload;
      return jsonRes(200, {
        ok: true,
        cloudSessionId: `cloud-${body.session.localSessionId}`,
        localSessionId: body.session.localSessionId,
        syncedMessageCount: 1,
        syncedAt: new Date().toISOString(),
      } satisfies SyncSuccessResponse);
    };

    const deps = makeDeps(store);
    const result = await syncPendingSessions(deps);

    assert.equal(result.total, 3);
    assert.equal(result.synced, 3);
    assert.equal(result.failed, 0);
    assert.equal(result.results.length, 3);
    for (const r of result.results) {
      assert.equal(r.ok, true);
    }
  });

  // ═══ T14: 批量同步（部分失败）═══
  it('T14: batch sync — 2 OK + 1 always 503 → synced=2, failed=1', async () => {
    const store = createMockStore({
      sessions: [
        { id: 'sess-c1', syncStatus: 'pending' },
        { id: 'sess-c2', syncStatus: 'pending' },
        { id: 'sess-c3', syncStatus: 'pending' },
      ],
      messages: {
        'sess-c1': [makeMsg()],
        'sess-c2': [makeMsg()],
        'sess-c3': [makeMsg()],
      },
    });

    fetchHandler = async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as SyncRequestPayload;
      if (body.session.localSessionId === 'sess-c2') {
        return jsonRes(503, { ok: false, error: 'service_unavailable', message: 'Down' });
      }
      return jsonRes(200, {
        ok: true,
        cloudSessionId: `cloud-${body.session.localSessionId}`,
        localSessionId: body.session.localSessionId,
        syncedMessageCount: 1,
        syncedAt: new Date().toISOString(),
      } satisfies SyncSuccessResponse);
    };

    const deps = makeDeps(store);
    const result = await syncPendingSessions(deps);

    assert.equal(result.total, 3);
    assert.equal(result.synced, 2);
    assert.equal(result.failed, 1);
  });

  // ═══ T15: error 状态手动重试 ═══
  it("T15: error status retry — sync_status='error' → accepted → synced", async () => {
    const store = createMockStore({
      sessions: [{ id: 'sess-t15', syncStatus: 'error' }],
      messages: { 'sess-t15': [makeMsg()] },
    });

    fetchHandler = async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as SyncRequestPayload;
      return jsonRes(200, {
        ok: true,
        cloudSessionId: 'cloud-t15',
        localSessionId: body.session.localSessionId,
        syncedMessageCount: 1,
        syncedAt: new Date().toISOString(),
      } satisfies SyncSuccessResponse);
    };

    const deps = makeDeps(store);
    const result = await syncSessionToTriMMC('sess-t15', deps);

    assert.equal(result.ok, true);
    assert.equal(result.cloudSessionId, 'cloud-t15');
    assert.equal(store._getSession('sess-t15')!.syncStatus, 'synced');
  });

  // ═══ T16: toolCalls 字段反序列化 ═══
  it('T16: toolCalls deserialization — valid JSON → correct format', () => {
    const session: SessionRecord = {
      id: 'sess-t16',
      status: 'active',
      model: 'test',
      systemPrompt: '',
      cwd: '/tmp',
      messageCount: 1,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T01:00:00.000Z',
      closedAt: null,
    };

    const toolCallsJson = JSON.stringify([
      { id: 'tc-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/test.txt"}' } },
      { id: 'tc-2', type: 'function', function: { name: 'write_file', arguments: '{"path":"/out.txt","content":"hi"}' } },
    ]);

    const messages: SyncMessageInput[] = [
      makeMsg({ role: 'assistant', content: null, toolCalls: toolCallsJson }),
    ];

    const { payload, truncated } = buildSyncPayload(session, messages, 'test-node', 5000);

    assert.equal(truncated, false);
    assert.equal(payload.session.messages.length, 1);
    const syncMsg = payload.session.messages[0];
    assert.ok(syncMsg.toolCalls);
    assert.equal(syncMsg.toolCalls!.length, 2);
    assert.equal(syncMsg.toolCalls![0].toolName, 'read_file');
    assert.deepEqual(syncMsg.toolCalls![0].input, { path: '/test.txt' });
    assert.equal(syncMsg.toolCalls![1].toolName, 'write_file');
    assert.deepEqual(syncMsg.toolCalls![1].input, { path: '/out.txt', content: 'hi' });
  });

  // ═══ T17: toolCalls 字段解析失败 ═══
  it('T17: toolCalls parse failure — corrupted JSON → silent skip, no crash', () => {
    const session: SessionRecord = {
      id: 'sess-t17',
      status: 'active',
      model: 'test',
      systemPrompt: '',
      cwd: '/tmp',
      messageCount: 1,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T01:00:00.000Z',
      closedAt: null,
    };

    const messages: SyncMessageInput[] = [
      makeMsg({ role: 'assistant', content: 'fallback text', toolCalls: '{corrupted-json!!!' }),
    ];

    const { payload, truncated } = buildSyncPayload(session, messages, 'test-node', 5000);

    assert.equal(truncated, false);
    assert.equal(payload.session.messages.length, 1);
    const syncMsg = payload.session.messages[0];
    // toolCalls should be undefined (silently skipped)
    assert.equal(syncMsg.toolCalls, undefined);
    assert.equal(syncMsg.content, 'fallback text');
  });
});
