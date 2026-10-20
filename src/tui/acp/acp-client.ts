// ── ACP (Agent Client Protocol) stdio client · dsh --profile acp 子进程面 ──
// D' 段 1 (架构稿 docs/execution/dprime-tui-acp-architecture-20261020.md):
//  - 裁决①: 不引入 @agentclientprotocol/sdk —— newline-delimited JSON-RPC 帧层自写
//    (5 请求 + 1 通知 + session/close 附加, ~200 行)。
//  - 帧形: 请求 {jsonrpc:"2.0",id,method,params} / 响应 {jsonrpc,id,result|error}
//    / 通知 {jsonrpc,method,params} (无 id)。行分隔, 每行一帧。
//  - D-46: 本文件零 console 打印; debug 观察面由调用方注入 debug() 且只记
//    method + sessionId + update 类型, 零内容面零凭据面。
//  - 零模型调用 (段 1): 真实 dsh 联调属段 2, 本文件只管进程与帧。
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** ACP method 名集中定义 —— 段 2 对真 dsh 联调时如帧名有出入, 改这一处。 */
export const ACP_METHODS = {
  initialize: 'initialize',
  sessionList: 'session/list',
  sessionNew: 'session/new',
  sessionResume: 'session/resume',
  sessionPrompt: 'session/prompt',
  sessionClose: 'session/close',
} as const;

/** 唯一通知 method: SessionNotification{sessionId, update{sessionUpdate 判别}}。 */
export const ACP_NOTIFICATION_METHOD = 'session/update';

/** prompt 为长跑请求 (等 settlement), 硬超时给长窗; 其余请求走缺省。 */
export const ACP_PROMPT_TIMEOUT_MS = 15 * 60_000;
export const ACP_DEFAULT_TIMEOUT_MS = 60_000;

/** stderr 环形捕获上限 (架构稿: 4KB)。 */
export const ACP_STDERR_TAIL_BYTES = 4 * 1024;

export interface AcpClientOptions {
  /** 可执行名; 缺省 env DSH_BIN ?? 'dsh'。 */
  command?: string;
  /** 缺省 ['--profile', 'acp']。 */
  args?: string[];
  /** 子进程 cwd; 缺省 process.cwd() (TUI 默认操作用户 cwd, slug 天然隔离)。 */
  cwd?: string;
  /** 请求硬超时缺省值。 */
  requestTimeoutMs?: number;
  /** prompt 长跑硬超时 (缺省 ACP_PROMPT_TIMEOUT_MS); 可注入短值测试。 */
  promptTimeoutMs?: number;
  /** D-46 debug 观察面: 只应记 method/sessionId/update 类型。 */
  debug?: (line: string) => void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class AcpClientError extends Error {
  /** 机器可读分类: 'timeout' | 'exited' | 'spawn' | 'protocol'。 */
  code: string;
  /** 进程 stderr 尾部 (≤4KB) —— 仅随 error 对象走 UI 展示, 不进日志。 */
  stderrTail?: string;
  constructor(message: string, code: string, stderrTail?: string) {
    super(message);
    this.name = 'AcpClientError';
    this.code = code;
    this.stderrTail = stderrTail;
  }
}

interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }
interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: unknown }

type JsonRpcFrame = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/** 客户端请求形 (帧形锚·架构稿 §二): 五请求参数/result 投影。 */
export interface AcpInitializeParams { protocolVersion: number; clientInfo: { name: string; version: string } }
export interface AcpSessionSummary { sessionId: string; updatedAt?: string }
export interface AcpPromptContentBlock { type: 'text'; text: string }

export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, PendingEntry>();
  private nextId = 1;
  private stderrTail = '';
  private exited = false;
  private notificationHandler: ((params: { sessionId: string; update: Record<string, unknown> }) => void) | null = null;
  private exitHandler: ((code: number | null) => void) | null = null;

  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly debug: (line: string) => void;

  constructor(opts: AcpClientOptions = {}) {
    this.command = opts.command ?? process.env.DSH_BIN ?? 'dsh';
    this.args = opts.args ?? ['--profile', 'acp'];
    this.cwd = opts.cwd ?? process.cwd();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? ACP_DEFAULT_TIMEOUT_MS;
    this.promptTimeoutMs = opts.promptTimeoutMs ?? ACP_PROMPT_TIMEOUT_MS;
    this.debug = opts.debug ?? (() => {});
  }

  get running(): boolean {
    return this.child !== null && !this.exited && this.child.exitCode === null;
  }

  /** 进程 stderr 尾部 (≤4KB) —— 错误诊断面。 */
  get stderrTailContent(): string {
    return this.stderrTail;
  }

  onNotification(fn: (params: { sessionId: string; update: Record<string, unknown> }) => void): void {
    this.notificationHandler = fn;
  }

  onExit(fn: (code: number | null) => void): void {
    this.exitHandler = fn;
  }

  /** spawn 子进程并接管 stdout 帧流 / stderr 尾部捕获 / exit 清理。 */
  start(): void {
    if (this.child) throw new AcpClientError('already started', 'protocol');
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      throw new AcpClientError(`spawn failed: ${(err as Error).message}`, 'spawn');
    }
    child.on('error', (err) => {
      // spawn 失败 (ENOENT 等) 以 error 事件形态到达 —— 折进统一 fail 路径。
      this.handleExit(null, new AcpClientError(`spawn error: ${err.message}`, 'spawn'));
    });
    this.child = child;
    this.exited = false;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    rl.on('close', () => { /* exit 事件统一收口 */ });

    child.stderr.on('data', (chunk: Buffer) => {
      // 环形尾部: 只保最后 4KB (架构稿 stderr 捕获 4KB 上限)。
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-ACP_STDERR_TAIL_BYTES);
    });

    child.on('exit', (code) => this.handleExit(code));
  }

  /** 载荷帧 → 传输行 (newline-delimited; 零内容面日志责任在调用方 debug)。 */
  private writeFrame(frame: JsonRpcFrame): void {
    const child = this.child;
    if (!child || this.exited) throw new AcpClientError('child process not running', 'exited', this.stderrTail);
    child.stdin.write(JSON.stringify(frame) + '\n');
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(trimmed) as JsonRpcFrame;
    } catch {
      // 非 JSON 行 (横幅/日志混流) —— 静默忽略, 不进 pending 语义。
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    if ('id' in frame && typeof (frame as JsonRpcResponse).id === 'number' && !('method' in frame)) {
      const res = frame as JsonRpcResponse;
      const entry = this.pending.get(res.id);
      if (!entry) return; // 未知 id (超时后迟到响应) —— 丢弃。
      this.pending.delete(res.id);
      clearTimeout(entry.timer);
      if (res.error) {
        entry.reject(new AcpClientError(`rpc error ${res.error.code}: ${res.error.message}`, 'protocol'));
      } else {
        entry.resolve(res.result);
      }
      return;
    }

    if ('method' in frame && !('id' in frame)) {
      const notif = frame as JsonRpcNotification;
      if (notif.method === ACP_NOTIFICATION_METHOD) {
        const params = (notif.params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
        const update = params.update ?? {};
        // D-46: 只出 update 类型判别, 零内容面。
        this.debug(`acp notify update=${String(update.sessionUpdate ?? 'unknown')} sessionId=${params.sessionId ?? ''}`);
        this.notificationHandler?.({ sessionId: params.sessionId ?? '', update });
      }
      // 其余通知 method: 忽略 (5 请求+1 通知形之外前向兼容)。
    }
  }

  private handleExit(code: number | null, spawnError?: AcpClientError): void {
    if (this.exited) return;
    this.exited = true;
    const err = spawnError ?? new AcpClientError(`child exited (code=${code})`, 'exited', this.stderrTail);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
    this.exitHandler?.(code);
  }

  /**
   * JSON-RPC 请求 + 硬超时。timeoutMs=0 表示不限 (仍受 exit 清理保护)。
   * D-46: debug 只记 method。
   */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.child || this.exited) throw new AcpClientError('child process not running', 'exited', this.stderrTail);
    const id = this.nextId++;
    const frame: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const timeout = timeoutMs ?? this.requestTimeoutMs;
    this.debug(`acp request method=${method} id=${id}`);
    return new Promise<T>((resolve, reject) => {
      const entry: PendingEntry = { resolve: resolve as (v: unknown) => void, reject, timer: undefined as unknown as NodeJS.Timeout };
      if (timeout > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpClientError(`request timeout after ${timeout}ms: ${method}`, 'timeout', this.stderrTail));
        }, timeout);
      } else {
        // timeoutMs=0 仍占位一个 timer 形状 (永不触发), 简化 entry 生命周期。
        entry.timer = setTimeout(() => {}, 2 ** 31 - 1);
      }
      this.pending.set(id, entry);
      try {
        this.writeFrame(frame);
      } catch (err) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  // ── 五请求薄封装 (帧形锚: 架构稿 §二) ──

  initialize(params: AcpInitializeParams): Promise<unknown> {
    return this.request(ACP_METHODS.initialize, params);
  }

  /** result 形: { sessions: AcpSessionSummary[] } (段 2 对真 dsh 校形)。 */
  listSessions(cwd: string): Promise<{ sessions?: AcpSessionSummary[] }> {
    return this.request(ACP_METHODS.sessionList, { cwd });
  }

  newSession(cwd: string): Promise<{ sessionId?: string }> {
    return this.request(ACP_METHODS.sessionNew, { cwd, mcpServers: [] });
  }

  resumeSession(sessionId: string, cwd: string): Promise<{ sessionId?: string }> {
    return this.request(ACP_METHODS.sessionResume, { sessionId, cwd, mcpServers: [] });
  }

  /** prompt: ContentBlock 数组载荷; settlement 走 response stopReason (无 idle 猜测)。
   *  超时=构造 promptTimeoutMs (缺省 15min 长窗), 不经此硬编码覆盖。 */
  prompt(sessionId: string, prompt: AcpPromptContentBlock[]): Promise<{ stopReason?: string }> {
    return this.request(ACP_METHODS.sessionPrompt, { sessionId, prompt }, this.promptTimeoutMs);
  }

  /** 裁决③: 正常退出 close —— P0' 实证 close 后段仍 resumable。 */
  closeSession(sessionId: string): Promise<unknown> {
    return this.request(ACP_METHODS.sessionClose, { sessionId }).catch(() => undefined);
  }

  /** 优雅收尾: close(尽力) → 短宽限 → kill。进程边界兜底, 段不删历史。 */
  async dispose(graceMs = 1500): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    try { child.stdin.end(); } catch { /* already gone */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, graceMs);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.handleExit(child.exitCode);
  }
}
