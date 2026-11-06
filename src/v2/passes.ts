// ── N7 Passes 调度环（形三 α · 设计卷 ec79feb7d §二·门①裁 c8544a1e7）──
//
// 原型 app/passes.ts 全 69 行正形移植（思想复用≠代码照抄·v2 收敛面=门①裁②）：
// - PassesHost 收敛形 {effects Pick kick/idle, health, closing, evaluateDue?}
//   ·engine.receive/triggers=嫁接域不移植（N4 划出表正身·注释锚）
//   ·configured 不移植（v2 无 Setup 面·恒可泵）
//   ·lifetime AbortSignal 不移植——v2 closingFlag holder 形收口（裁②正形注）
// - evaluateDue 留位 noop（裁③·Eval 嫁接位注释锚·候事件源域注入）
// - interval 缺省 2000ms 照原型·构造可注入（裁①·测试 10ms 级）
// - handler 注册面=Effects.handle（effects.ts β-2 正形·start/deliver-input/
//   executor 真消费 handler=嫁接域不注册行留库候消费·裁⑤——Passes=泵环消费
//   机制本体·reply 真消费已通 N1 落形）。

import type { Effects } from './effects.js';

export interface PassesHealthEntry {
  state: 'ready' | 'error';
  detail: string;
  at: string;
}

/** health 读写面（Engine 组合注入 holder·零引现役 HealthBoard）。 */
export interface PassesHealthFace {
  get(): PassesHealthEntry | undefined;
  set(entry: PassesHealthEntry): void;
}

export interface PassesHost {
  readonly effects: Pick<Effects, 'kick' | 'idle'>;
  readonly health: PassesHealthFace;
  readonly closing: () => boolean;
  /** Eval 评估泵留位（裁③：缺省 noop·Eval=嫁接域门①裁⑥·候事件源域）。 */
  readonly evaluateDue?: () => void;
}

const now = (): string => new Date().toISOString();

/**
 * Schedules and serializes orchestration passes that drive due effects
 * （原型正形语义）：周期泵+按需泵合并单飞驱动 Effects dispatch 与留位评估泵。
 * Runtime/组合方管理生命周期；Engine 不自动 start（组合方显式调·runtime.ts
 * 初始化序 passes.start() 同构位）。
 */
export class Passes {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private pumping?: Promise<void>;
  private pumpAgain?: Promise<void>;

  constructor(private readonly host: PassesHost, private readonly intervalMs = 2000) {}

  start(): void {
    if (!this.stopped) this.timer = setInterval(() => { void this.request(); }, this.intervalMs);
  }

  stop(): Promise<unknown> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    return Promise.allSettled([this.pumping, this.pumpAgain]);
  }

  request(): void {
    const { health } = this.host;
    void this.pump().then(() => {
      if (health.get()?.state !== 'error') return;
      health.set({ state: 'ready', detail: 'Passes are ready', at: now() });
    }, (error: unknown) => {
      health.set({ state: 'error', detail: `A pass failed: ${String(error)}`, at: now() });
    });
  }

  /** Wait until no pass or effect that can start now is running.（原型正形） */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.pumpAgain]);
      await this.host.effects.idle();
      if (!this.pumping && !this.pumpAgain) return;
    }
  }

  /** Run one pass, coalescing concurrent callers into a single follow-up pass.（原型正形·双 promise 槽） */
  async pump(): Promise<void> {
    // closing 时零泵（原型 configured/closing 判位·裁②收敛面）。
    if (this.host.closing()) return;
    if (!this.pumping) return this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined; });
    const next = () => { this.pumpAgain = undefined; return this.pump(); };
    return this.pumpAgain ??= this.pumping.then(next, next);
  }

  private async pumpOnce(): Promise<void> {
    this.host.effects.kick();
    if (this.host.closing()) return;
    // evaluateDue 留位（裁③·Eval 嫁接位）。
    this.host.evaluateDue?.();
  }
}
