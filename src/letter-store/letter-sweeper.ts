// ── TriLC Letter Sweeper（LG-026-P3-R3/R4）──
// 定时扫描信箱超时/到期件，驱动 L3 急件抢占升级链与 ttl 到期处理。
// 落法=session-reaper 同款内部 sweep（setInterval+unref）——不入用户 cron jobs
// CRUD 面（内部职责不暴露给 job 列表/删除面），CTO 派工令「cron 面挂定时扫描」
// 的广义定时面承载，落法差异回报候核。
//
// 升级链（BOD 裁数值照用）：
//   重要件（C-suite 收件人）：delivered 超 4h 未 read → 组长重推一次
//     （recordRetry+wake）→ 再超 4h 仍未 read → 自动 escalate
//   重要件（执行席）：同构，阈值 1 工作日（按 24h 自然日折算，可配）
//   急件：零等待即时升——宽限 graceMs（默认 30min，防组长 wake 竞态）后
//     仍 pending/delivered → 即时 escalate（不经重推链）
//   ttl 到期未投件（R4）：重推留痕（recordRetry）→ 重试超限（maxRetries）
//     → escalate
//
// escalate 一律走 escalateLetter 原子 API（冻结原信+建 ref 新信封，CTO 终验
// 裁示③同款语义），升级执行 actor=组长注册名（LEAD_AGENT_ID，形式复核执行者）。

import type { LetterStore } from './store.js';
import { LEAD_AGENT_ID } from './store.js';
import type { LetterRecord } from './types.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5min 扫描周期
const DEFAULT_C_SUITE_HOURS = 4;
const DEFAULT_EXECUTION_HOURS = 24; // 1 工作日按自然日折算
const DEFAULT_URGENT_GRACE_MS = 30 * 60 * 1000; // 急件零等待宽限（防组长 wake 竞态）
const DEFAULT_MAX_RETRIES = 3;

// C-suite 收件人名单（CPO 业务规则：C-suite 4h / 执行席 1 工作日）——可配覆盖
const DEFAULT_C_SUITE_RECIPIENTS = [
  'CEO', 'COS', 'CTO', 'CPO', 'CFO', 'CAO', 'CHO', 'CMO', 'COO',
  '首席执行官', '总助', '首席技术官', '首席产品官', '首席财务官',
  '首席行政官', '首席人力资源官', '首席营销官', '首席运营官',
];

export interface LetterSweeperOptions {
  intervalMs?: number;
  cSuiteHours?: number;
  executionHours?: number;
  urgentGraceMs?: number;
  maxRetries?: number;
  cSuiteRecipients?: string[];
}

export interface LetterSweeperDeps {
  letterStore: LetterStore;
  /** 组长重推唤醒（同进程 requestHeartbeatNow action） */
  wake: () => void;
  /** 升级信封接收方（升级链固定组长→COS→BOD，落 COS） */
  escalateTo?: string;
  onSweep?: (summary: { rescued: number; escalated: number; expired: number }) => void;
}

function ageMs(iso: string | null): number {
  if (!iso) return 0;
  return Date.now() - new Date(iso).getTime();
}

export function createLetterSweeper(deps: LetterSweeperDeps, opts: LetterSweeperOptions = {}) {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const cSuiteHours = opts.cSuiteHours ?? DEFAULT_C_SUITE_HOURS;
  const executionHours = opts.executionHours ?? DEFAULT_EXECUTION_HOURS;
  const urgentGraceMs = opts.urgentGraceMs ?? DEFAULT_URGENT_GRACE_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const cSuite = new Set(opts.cSuiteRecipients ?? DEFAULT_C_SUITE_RECIPIENTS);
  const escalateTo = deps.escalateTo ?? 'COS';

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /** 组长重推 = 留痕 + wake（信件本身已 delivered；重推语义=再次触达收件席） */
  function rePush(letter: LetterRecord, reason: string): void {
    deps.letterStore.recordRetry(letter.letterId, reason);
    deps.wake();
    console.log(`[trilc:letter-sweep] re-push ${letter.letterId} (${reason})`);
  }

  /** 原子升级：冻结原信 + 建 ref 新信封（escalateLetter 单事务） */
  function escalate(letter: LetterRecord, reason: string): boolean {
    try {
      deps.letterStore.escalateLetter(letter.letterId, LEAD_AGENT_ID, {
        from: LEAD_AGENT_ID,
        to: escalateTo,
        priority: '急件',
        payload: { reason, escalatedBy: `${LEAD_AGENT_ID}(auto-sweep)` },
      });
      console.log(`[trilc:letter-sweep] escalated ${letter.letterId} → ${escalateTo} (${reason})`);
      return true;
    } catch (err) {
      // 竞态（收件人恰好已读/已办结等）：记日志不重试，下轮扫描按新状态判定
      console.warn(`[trilc:letter-sweep] escalate ${letter.letterId} failed: ${(err as Error).message}`);
      return false;
    }
  }

  function isCSuite(recipient: string): boolean {
    return cSuite.has(recipient);
  }

  // ── Sweep ──

  function sweep(): { rescued: number; escalated: number; expired: number } {
    let rescued = 0;
    let escalated = 0;
    let expired = 0;

    // R3 重要件：delivered 未 read 超阈值 → 重推一次 → 再超时 escalate
    const delivered = deps.letterStore.listLetters({ status: 'delivered', priority: '重要' });
    for (const letter of delivered) {
      const thresholdMs = (isCSuite(letter.to) ? cSuiteHours : executionHours) * 3_600_000;
      const waited = ageMs(letter.deliveredAt);
      if (waited < thresholdMs) continue;
      if (letter.retries === 0) {
        rePush(letter, `重要件超时未读(${Math.round(waited / 60000)}min)，组长重推`);
        rescued++;
      } else if (waited >= thresholdMs * 2) {
        if (escalate(letter, `重要件重推后仍未读(${Math.round(waited / 60000)}min)`)) escalated++;
      }
    }

    // R3 急件：零等待即时升（宽限 graceMs 后仍 pending/delivered）
    const urgent = deps.letterStore.listLetters({ priority: '急件' });
    for (const letter of urgent) {
      if (letter.status !== 'pending' && letter.status !== 'delivered') continue;
      if (ageMs(letter.createdAt) < urgentGraceMs) continue;
      if (escalate(letter, `急件零等待升级(宽限${Math.round(urgentGraceMs / 60000)}min后仍${letter.status})`)) escalated++;
    }

    // R4 ttl 到期未投件：重推留痕 → 重试超限 escalate
    const pending = deps.letterStore.listLetters({ status: 'pending' });
    for (const letter of pending) {
      if (letter.ttlSeconds === null) continue;
      if (ageMs(letter.createdAt) < letter.ttlSeconds * 1000) continue;
      expired++;
      if (letter.retries < maxRetries) {
        rePush(letter, `ttl 到期未投(${letter.ttlSeconds}s)，重推 ${letter.retries + 1}/${maxRetries}`);
        rescued++;
      } else {
        if (escalate(letter, `ttl 到期重试超限(${letter.retries}次)`)) escalated++;
      }
    }

    return { rescued, escalated, expired };
  }

  function runSweep(): { rescued: number; escalated: number; expired: number } {
    if (running) return { rescued: 0, escalated: 0, expired: 0 }; // 防重入（防御性保留）
    running = true;
    try {
      const summary = sweep();
      if (summary.rescued || summary.escalated || summary.expired) {
        deps.onSweep?.(summary);
        console.log(`[trilc:letter-sweep] sweep: rescued=${summary.rescued} escalated=${summary.escalated} expired=${summary.expired}`);
      }
      return summary;
    } finally {
      running = false;
    }
  }

  // ── Lifecycle（session-reaper 同款）──

  function start(): void {
    if (timer) return;
    console.log(`[trilc:letter-sweep] started (interval=${intervalMs}ms)`);
    timer = setInterval(() => {
      try { runSweep(); } catch (err) {
        console.error(`[trilc:letter-sweep] sweep failed:`, err instanceof Error ? err.message : String(err));
      }
    }, intervalMs);
    timer.unref();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    console.log(`[trilc:letter-sweep] stopped`);
  }

  function isRunning(): boolean {
    return timer !== null;
  }

  return { sweep: runSweep, start, stop, isRunning };
}

export type LetterSweeper = ReturnType<typeof createLetterSweeper>;
