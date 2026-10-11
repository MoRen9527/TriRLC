// ── LG-069 二期从闸（8711 follower·CTO 稿 a00045f1 §2.3/§四.1）──
// 8711 只「跟随」8713 主闸闸态（healthz 免鉴权只读面·稿 §2.2 三裁据），
// 不做独立电量检测（双真值源禁令）；hard 闸停自身新派发（在跑不中断）。
//
// 状态机（纯函数·单测直驱）：
//   following(hard|soft|none) — 直接镜像主闸 gate（8713 裁决即最终裁决）
//   poll 失败 → holding（持有 lastKnownGate，不即时 fail-open：8713 崩≠电量恢复）
//   连续 3 次 poll 失败 → unknown + urgent 告警一次/失效段
//   following 中 staleness（now-lastReadAt > 5min 或 lastReadAt 缺位）→ unknown + 告警
//   unknown 中 poll 成功且新鲜 → 直接回 following（无滞回——跟随者无抖动源）
// 派发语义：following/holding 且 gate==='hard' → 新派发 skip（power_gate_hard）；
//   following(soft) → 放行+日志；unknown → 放行+告警不停工（如实边界：闸控职责
//   在主闸+人工兜底，8711 停工权只跟主闸闸态走）。
//
// 告警面 v1 如实边界（稿 §2.4）：告警条件恰是「主闸不可达」——本地日志+
// healthz follower 段可见化，零循环依赖；跨席扇出候观察项（bod-tick 已扩探）。
//
// 前置件协同（稿 §五）：staleness 判定消费 8713 healthz.power.lastReadAt——该
// 投影明晨窗才落，未落窗期 lastReadAt 缺位 → 传染 unknown 放行态上线（COO 窗令
// 预期形·不阻塞施工），投影落窗后自动变活，零返工。
//
// 回滚通道：TRILC_POWER_FOLLOW 非 '1' → 完全旁路（模块不实例化·dispatch 谓词恒 false）。

// ── Types ──

export type FollowGate = "none" | "soft" | "hard";
export type FollowerMode = "following" | "holding" | "unknown";

export interface FollowerRuntimeState {
  mode: FollowerMode;
  /** following=镜像 gate；holding=持有 gate；unknown=null。 */
  gate: FollowGate | null;
  /** 连续 poll 网络失败计数（poll-ok 归零；staleness 不计入——state 面已可见）。 */
  consecutivePollFailures: number;
  /** 当前退化段（unknown）是否已告警——告警一次每段。 */
  segmentAlerted: boolean;
}

export interface FollowerTransition {
  state: FollowerRuntimeState;
  /** 非 null = urgent 告警行（调用方 console.error 落日志面）。 */
  alert: string | null;
}

export type FollowerInput =
  | { kind: "poll-ok"; gate: FollowGate; lastReadAt: string | null; nowMs: number }
  | { kind: "poll-fail" };

export const FOLLOWER_STALE_MS_DEFAULT = 5 * 60_000;
export const FOLLOWER_POLL_MS_DEFAULT = 60_000;

/** 初始态：unknown（启动事实非退化事件——segmentAlerted=true 不触发告警风暴，
 * 首个 poll 结果落定真实态）。 */
export function initialFollowerState(): FollowerRuntimeState {
  return { mode: "unknown", gate: null, consecutivePollFailures: 0, segmentAlerted: true };
}

/** staleness 判定：lastReadAt 缺位/不可解析/超窗 → true（缺位=前置件未落窗形态）。 */
export function isStale(lastReadAt: string | null, nowMs: number, staleMs: number): boolean {
  if (lastReadAt == null) return true;
  const t = Date.parse(lastReadAt);
  if (Number.isNaN(t)) return true;
  return nowMs - t > staleMs;
}

/** 纯函数转移。不变式：mode==='unknown' ⟹ segmentAlerted=true。 */
export function transitionFollower(
  prev: FollowerRuntimeState,
  input: FollowerInput,
  staleMs: number = FOLLOWER_STALE_MS_DEFAULT,
): FollowerTransition {
  if (input.kind === "poll-fail") {
    const consecutivePollFailures = prev.consecutivePollFailures + 1;
    if (consecutivePollFailures >= 3) {
      // ×3 → unknown + urgent 告警一次/失效段
      const alert = prev.segmentAlerted ? null : "follower-primary-unreachable (3 consecutive poll failures)";
      return {
        state: { mode: "unknown", gate: null, consecutivePollFailures, segmentAlerted: true },
        alert,
      };
    }
    // holding：持有 lastKnownGate，不即时 fail-open
    return {
      state: {
        mode: "holding",
        gate: prev.gate ?? "none",
        consecutivePollFailures,
        segmentAlerted: prev.segmentAlerted,
      },
      alert: null,
    };
  }

  // poll-ok
  if (isStale(input.lastReadAt, input.nowMs, staleMs)) {
    // staleness 传染 unknown（主闸读链故障防御）——新段告警一次
    const alert = prev.segmentAlerted ? null : "follower-primary-stale (lastReadAt missing or older than staleness window)";
    return {
      state: { mode: "unknown", gate: null, consecutivePollFailures: 0, segmentAlerted: true },
      alert,
    };
  }
  // 新鲜 → 直接回 following 镜像（无滞回），段计数清零
  return {
    state: { mode: "following", gate: input.gate, consecutivePollFailures: 0, segmentAlerted: false },
    alert: null,
  };
}

/** dispatch 谓词正形：following/holding 且 gate==='hard' → true（停新派发）。
 * unknown → false（放行+告警不停工·稿 §2.3 如实边界）。 */
export function followerGateHard(state: FollowerRuntimeState): boolean {
  return (state.mode === "following" || state.mode === "holding") && state.gate === "hard";
}

// ── healthz 投影（稿 §四.4 四键·与 8713 power 段观测面对称）──

export interface FollowerHealthz {
  /** 'following/hard' | 'holding/soft' | 'unknown' …（单字符串直读·runner 兼容）。 */
  state: string;
  lastPollAt: string | null;
  lastGateSeen: FollowGate | null;
  pollFailures: number;
}

export function followerHealthz(state: FollowerRuntimeState, lastPollAt: string | null): FollowerHealthz {
  return {
    state: state.mode === "unknown" ? "unknown" : `${state.mode}/${state.gate}`,
    lastPollAt,
    lastGateSeen: state.mode === "unknown" ? null : state.gate,
    pollFailures: state.consecutivePollFailures,
  };
}

// ── poll 循环（生命周期）──

export interface PowerFollowerOpts {
  /** 主闸 healthz 只读面（TRILC_FOLLOW_PRIMARY_URL，缺省 http://127.0.0.1:8713/healthz）。 */
  primaryUrl: string;
  pollMs: number;
  staleMs: number;
  /** 常规观测行（态变化/恢复）；默认 console.log('[trilc:follow] …')。 */
  log?: (line: string) => void;
  /** urgent 告警行（段首）；默认 console.error。 */
  warn?: (line: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface PowerFollowerHandle {
  /** dispatch 谓词（app.ts 闭包注入 cron deps 用）。 */
  isHard(): boolean;
  healthz(): FollowerHealthz;
  stop(): void;
}

const GATE_WHITELIST: readonly FollowGate[] = ["none", "soft", "hard"];

export function startPowerFollower(opts: PowerFollowerOpts): PowerFollowerHandle {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((line: string) => console.log(`[trilc:follow] ${line}`));
  const warn = opts.warn ?? ((line: string) => console.error(`[trilc:follow] URGENT ${line}`));

  let rt: FollowerRuntimeState = initialFollowerState();
  let lastPollAt: string | null = null;
  let stopped = false;

  const apply = (t: FollowerTransition): void => {
    const prev = rt;
    rt = t.state;
    if (t.alert) warn(t.alert);
    if (prev.mode !== rt.mode || prev.gate !== rt.gate) {
      log(`state ${describeState(prev)} → ${describeState(rt)}`);
    }
  };

  const poll = async (): Promise<void> => {
    lastPollAt = new Date().toISOString();
    try {
      const res = await fetchImpl(opts.primaryUrl, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`primary healthz HTTP ${res.status}`);
      const j = (await res.json()) as { power?: { gate?: unknown; lastReadAt?: unknown } };
      const gate = j.power?.gate;
      // power 段缺/gate 非法 → 数据形坏=读链故障 → poll-fail 形（holding 持有防御）
      if (!j.power || typeof gate !== "string" || !GATE_WHITELIST.includes(gate as FollowGate)) {
        apply(transitionFollower(rt, { kind: "poll-fail" }));
        return;
      }
      apply(
        transitionFollower(rt, {
          kind: "poll-ok",
          gate: gate as FollowGate,
          lastReadAt: typeof j.power.lastReadAt === "string" ? j.power.lastReadAt : null,
          nowMs: now(),
        }),
      );
    } catch {
      apply(transitionFollower(rt, { kind: "poll-fail" }));
    }
  };

  const timer = setInterval(() => {
    if (!stopped) void poll();
  }, opts.pollMs);
  // 首拍不等待整周期（启动即落定真实态）
  void poll();
  timer.unref?.();

  return {
    isHard: () => followerGateHard(rt),
    healthz: () => followerHealthz(rt, lastPollAt),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function describeState(s: FollowerRuntimeState): string {
  return s.mode === "unknown" ? "unknown" : `${s.mode}/${s.gate}`;
}
