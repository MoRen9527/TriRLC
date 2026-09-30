// ── TriRLC TaskMirrorPusher ──
// S7: Event-driven task state push to TriMMC mirror endpoint.
// Subscribes to localBus task:* events + 30s heartbeat full-push.
// CPO Q6c + CTO §7.2 S7 §3.3.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { localBus, type LocalBusEvent } from '../localbus/bus.js';
import type { MirrorTaskSnapshot } from './types.js';

export class TaskMirrorPusher {
  private trimcBaseUrl: string;
  private nodeId: string;
  private mirrorInterval: NodeJS.Timeout | null = null;
  private enabled = true;

  constructor(
    trimcBaseUrl: string,
    nodeId: string,
    /** 获取当前所有活跃任务的快照 */
    private getActiveSnapshots: () => MirrorTaskSnapshot[],
  ) {
    this.trimcBaseUrl = trimcBaseUrl;
    this.nodeId = nodeId;
  }

  /**
   * 启动：订阅 localBus 事件 + 启动 30s 心跳
   */
  start(): void {
    // ① 订阅 localBus
    localBus.on('event', this.onLocalBusEvent);

    // ② 启动 30s 心跳（与 ConnectionManager 心跳错开 15s，避免同时压 TriMMC）
    this.mirrorInterval = setInterval(() => {
      this.heartbeatPush().catch(() => {});
    }, 30_000);
  }

  /**
   * 事件驱动推送：状态变更时立即推送单个任务
   */
  private onLocalBusEvent = (event: LocalBusEvent): void => {
    if (!this.enabled) return;
    if (!event.type.startsWith('task:')) return;

    const taskId = 'taskId' in event ? (event as { taskId: string }).taskId : undefined;
    if (!taskId) return;

    // 构建单任务 mirror payload
    const snapshot = this.buildSnapshot(taskId);
    if (!snapshot) return;

    this.push([snapshot]).catch(() => {});
  };

  /**
   * 心跳兜底：全量推送当前 active 任务
   */
  private async heartbeatPush(): Promise<void> {
    if (!this.enabled) return;
    const snapshots = this.getActiveSnapshots();
    if (snapshots.length === 0) return; // 无活跃任务，跳过
    await this.push(snapshots);
  }

  /**
   * HTTP POST to TriMMC /internal/v1/tasks/mirror
   */
  private async push(tasks: MirrorTaskSnapshot[]): Promise<void> {
    const body = JSON.stringify({ nodeId: this.nodeId, tasks });
    await postMirror(this.trimcBaseUrl, body, 5_000);
  }

  /** 连接恢复时调用：全量推送 */
  onReconnected(): void {
    this.heartbeatPush().catch(() => {});
  }

  /** 连接降级时调用：停止推送 */
  onDegraded(): void {
    // 不主动 mark unknown — TriMMC 端通过心跳超时自行判断
    // 这样避免 degraded→connected 反复横跳导致状态抖动
  }

  /**
   * 从活跃任务快照中查找指定 taskId 的快照
   */
  private buildSnapshot(taskId: string): MirrorTaskSnapshot | null {
    const snapshots = this.getActiveSnapshots();
    return snapshots.find((s) => s.taskId === taskId) ?? null;
  }

  stop(): void {
    this.enabled = false;
    localBus.off('event', this.onLocalBusEvent);
    if (this.mirrorInterval) {
      clearInterval(this.mirrorInterval);
      this.mirrorInterval = null;
    }
  }
}

// ── HTTP helpers ──

/**
 * POST mirror payload to TriMMC.
 * Fire-and-forget with 5s timeout — mirror 失败不影响本地功能。
 */
function postMirror(
  baseUrl: string,
  body: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL('/internal/v1/tasks/mirror', baseUrl);
    const reqFn = urlObj.protocol === 'https:' ? httpsRequest : httpRequest;

    const req = reqFn(
      {
        method: 'POST',
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
          // P0 加固配套：TriMMC /internal token 门（同 postHeartbeat）
          ...(process.env.TRIMC_INTERNAL_TOKEN
            ? { 'X-Internal-Token': process.env.TRIMC_INTERNAL_TOKEN }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (data.ok === true) {
              resolve();
            } else {
              reject(new Error(`mirror rejected: ${JSON.stringify(data)}`));
            }
          } catch (err) {
            reject(new Error(`invalid mirror response: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      },
    );

    req.on('error', (err) => {
      // 静默失败 — mirror 失败不影响本地功能（CPO 6c 设计原则）
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('mirror timeout'));
    });

    req.write(body);
    req.end();
  });
}
