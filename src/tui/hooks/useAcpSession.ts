// ── ACP session hook (D' 段 1) ──
// 对外接口形对齐 useChat (app.tsx L101 消费面全覆盖): messages/blocks + send +
// requestState + abort/error/tokens/... 另扩 todos (plan→TodoPanel)。
// session 生命周期 (架构稿裁决③): 启动 initialize → session/list{cwd} →
// 有段 resume 最新 / 无段 session/new; 卸载 close (P0' 实证 close 后仍 resumable)。
// 映射逻辑全在 session-mapping.ts 纯函数 —— 本文件只是 React state 绑定壳。
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { AcpClient, AcpClientError, ACP_METHODS } from '../acp/acp-client.js';
import type { AcpSessionSummary } from '../acp/acp-client.js';
import { applySessionUpdate, buildPromptBlocks, settleStreaming } from '../acp/session-mapping.js';
import type { Message } from './useChat.js';
import type { TodoTask } from '../components/TodoPanel.js';
import type { RequestState } from './useChat.js';

const CLIENT_INFO = { name: 'trirlc-tui', version: '0.9.0' };

/** app.tsx 消费面 (useChat 返回形) + ACP 扩展字段。 */
export interface AcpSessionApi {
  messages: Message[];
  send: (text: string) => void;
  isLoading: boolean;
  requestState: RequestState;
  error: string | null;
  abort: () => void;
  sessionId: () => string | null;
  loadSession: (sid: string) => Promise<{ messages: Message[]; sessionId: string } | null>;
  clearMessages: () => void;
  addSystemMessage: (content: string) => void;
  inputTokens: number;
  outputTokens: number;
  model: string;
  setModel: (m: string) => void;
  // ── ACP 扩展 ──
  /** plan update → TodoPanel 形。 */
  todos: TodoTask[];
  /** 生命周期相位: booting=initialize/list 中; ready=可 send; closed/failed。 */
  phase: 'idle' | 'booting' | 'ready' | 'failed';
}

export function useAcpSession({ enabled }: { enabled: boolean }): AcpSessionApi {
  const [messages, setMessages] = useState<Message[]>([]);
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [todos, setTodos] = useState<TodoTask[]>([]);
  const [phase, setPhase] = useState<AcpSessionApi['phase']>('idle');
  const clientRef = useRef<AcpClient | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const doneRef = useRef(false);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  // ── 生命周期: mount 启动 / unmount close ──
  useEffect(() => {
    if (!enabled) return;
    setPhase('booting');
    // D-46: 生产面 debug 静默 (TUI patchConsole=false, console 会污染画面);
    // 观察需要时临时注入 debug 收集器, 只记 method/sessionId/update 类型。
    const client = new AcpClient({});
    clientRef.current = client;

    client.onNotification(({ update }) => {
      setMessages((prev) => {
        const res = applySessionUpdate(prev, update as never);
        if (res.inputTokens !== null) setInputTokens(res.inputTokens);
        if (res.outputTokens !== null) setOutputTokens(res.outputTokens);
        if (res.todos.length > 0) setTodos(res.todos);
        return res.messages;
      });
    });
    client.onExit((code) => {
      setError((prev) => prev ?? `dsh process exited (code=${code})`);
      setPhase('failed');
      setRequestState('idle');
    });

    let cancelled = false;
    (async () => {
      try {
        client.start();
        await client.initialize({ protocolVersion: 1, clientInfo: CLIENT_INFO });
        const cwd = process.cwd();
        const list = await client.listSessions(cwd).catch((): { sessions?: AcpSessionSummary[] } => ({ sessions: [] }));
        if (cancelled) return;
        const sessions = [...(list.sessions ?? [])].sort((a, b) =>
          String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
        );
        let sid: string | null = null;
        if (sessions.length > 0 && sessions[0]!.sessionId) {
          // 有段 resume 最新 (「打开就聊」)。
          const resumed = await client.resumeSession(sessions[0]!.sessionId, cwd);
          sid = resumed.sessionId ?? sessions[0]!.sessionId;
        } else {
          const created = await client.newSession(cwd);
          sid = created.sessionId ?? null;
        }
        if (cancelled) return;
        if (!sid) throw new AcpClientError('no sessionId from session/new', 'protocol');
        sessionIdRef.current = sid;
        setSessionId(sid);
        setRequestState('idle');
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        const e = err as AcpClientError;
        setError(e.stderrTail ? `${e.message} :: ${e.stderrTail.slice(-400)}` : e.message);
        setPhase('failed');
        setRequestState('idle');
      }
    })();

    return () => {
      cancelled = true;
      const sid = sessionIdRef.current;
      const c = clientRef.current;
      clientRef.current = null;
      if (c) {
        // 裁决③: 正常退出 close (释放运行态不删历史) 后收进程。
        const closeChain = (sid ? c.closeSession(sid) : Promise.resolve()).then(() => c.dispose());
        closeChain.catch(() => c.dispose());
      }
    };
  }, [enabled]);

  const send = useCallback((text: string) => {
    const client = clientRef.current;
    if (!text.trim() || requestState !== 'idle') return;
    if (!client || !sessionIdRef.current || phase !== 'ready') {
      setError((prev) => prev ?? 'ACP session not ready');
      return;
    }
    doneRef.current = false;
    setError(null);
    const sid = sessionIdRef.current;
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, isStreaming: false },
      { role: 'assistant', content: '', isStreaming: true, toolCalls: [], blocks: [] },
    ]);
    setRequestState('waitingForFirstToken');
    client
      .prompt(sid, buildPromptBlocks(text))
      .then(() => {
        // settlement 走 response stopReason —— 无 idle 猜测。
        if (doneRef.current) return;
        doneRef.current = true;
        setRequestState('idle');
        setMessages((prev) => settleStreaming(prev));
      })
      .catch((err: AcpClientError) => {
        if (doneRef.current) return;
        doneRef.current = true;
        setRequestState('idle');
        setError(err.stderrTail ? `${err.message} :: ${err.stderrTail.slice(-400)}` : err.message);
        setMessages((prev) => settleStreaming(prev, { errorText: err.message }));
      });
  }, [requestState, phase]);

  const abort = useCallback(() => {
    // 段 1 形: 本地置 idle + settle; 进程不杀 (prompt 硬超时兜底)。
    // 段 2 候窗: 对 ACP cancel 通知机制 (session/cancel)。
    doneRef.current = true;
    setRequestState('idle');
    setMessages((prev) => settleStreaming(prev));
  }, []);

  // ── useChat 形补齐 (ACP 面语义化 no-op / 轻实现) ──
  const loadSession = useCallback(async (_sid: string) => null, []); // 生命周期自管 (list→resume)
  const clearMessages = useCallback(() => {
    setMessages([]); setTodos([]);
  }, []);
  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [...prev, { role: 'assistant', content, isStreaming: false }]);
  }, []);
  const getSessionId = useCallback(() => sessionId, [sessionId]);
  const setModel = useCallback((_m: string) => { /* model 由 dsh 侧定 (裁决: 零本地干预) */ }, []);

  return useMemo(() => ({
    messages, send, isLoading: requestState !== 'idle', requestState, error, abort,
    sessionId: getSessionId, loadSession, clearMessages, addSystemMessage,
    inputTokens, outputTokens, model: 'acp', setModel, todos, phase,
  }), [messages, send, requestState, error, abort, getSessionId, loadSession, clearMessages, addSystemMessage, inputTokens, outputTokens, setModel, todos, phase]);
}

// ACP_METHODS 引用保持 (re-export 面: 段 2 联调时 hook 级调用免再 import)。
export { ACP_METHODS };
