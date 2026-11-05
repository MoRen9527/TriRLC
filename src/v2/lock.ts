// ── N1 目录锁（形三 α · 门①裁定 2026-11-06 CTO 采认 wx 独占创建形）──
//
// flock 语义 Windows 落形（裁定①）：POSIX flock=内核级文件锁·Windows node 无
// 原生 flock——wx（O_CREAT|O_EXCL）独占创建达成同一行为契约（独占语义+第二
// 实例立即退出）且零新依赖（pidfile 工具族同构）。proper-lockfile 不采（依赖面）。
//
// 双语义（活锁/stale）：
//   活锁持有者（pid 活·isProcessAlive 探测复用 pidfile.ts）→LockHeldError 立即
//   抛（第二实例入口面捕获→打印指向→非零 exit——不等待不夺位）。
//   stale（持有者 pid 死/锁内容损坏）→安全夺位（unlink 后 wx 重建）。
//
// 语义差如实注（裁定①·毕报须带）：flock 进程死自动释放零残留；wx 文件进程死
// 残留=stale 探测兜底——行为等价成立。残余风险两点记档：
//   ①pid 复用误判（持有者死+pid 被新进程复用→误判活锁不夺位）——误判方向
//     保守（可用性损失非数据损坏·竞态窗极小）；
//   ②stale 夺位 unlink→wx 重建非原子（两实例并发夺位窗）——wx 独占收敛
//     （一胜一 EEXIST 再走活锁/stale 判定·MAX_ATTEMPTS 内收敛）。
// release 闭包守卫（裁定①）：unlink 前校验文件内容 pid==自 pid（防 stale 夺位
// 后旧闭包误删新锁——不按路径盲删）。

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive } from '../pidfile.js';

/** 第二实例错误（pid=现持有者·入口面捕获→打印指向→非零 exit）。 */
export class LockHeldError extends Error {
  constructor(readonly pid: number) {
    super(`Another engine instance holds the v2 lock (pid ${pid})`);
    this.name = 'LockHeldError';
  }
}

export interface DirectoryLock {
  /** 持有者 pid（=acquire 时本进程）。 */
  readonly pid: number;
  /** 锁文件路径。 */
  readonly path: string;
  /** 释放（闭包守卫：文件内容 pid==自 pid 才 unlink——非本实例的锁零副作用）。 */
  release(): void;
}

const LOCK_FILE = 'v2.lock';
const MAX_ACQUIRE_ATTEMPTS = 3;

/** 读锁文件 pid（损坏/缺→undefined=stale 方向——持有者异常时的保守夺位）。 */
function readLockPid(lockPath: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

/** wx 独占创建+写内容 {pid, at}（EEXIST 即败=独占语义正身）。 */
function writeLock(lockPath: string): void {
  const fd = openSync(lockPath, 'wx');
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
}

/**
 * 目录锁独占获取（N1 Engine 单写者·跨进程互斥正身）：成功=DirectoryLock·
 * 活锁=LockHeldError 立即抛·stale=安全夺位。
 */
export function acquireDirectoryLock(stateDir: string): DirectoryLock {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, LOCK_FILE);
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      writeLock(lockPath);
      return {
        pid: process.pid,
        path: lockPath,
        release() {
          if (readLockPid(lockPath) !== process.pid) return; // 守卫：非本实例的锁不动
          try { unlinkSync(lockPath); } catch { /* 已被并发处理——零副作用 */ }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const heldPid = readLockPid(lockPath);
      if (heldPid !== undefined && isProcessAlive(heldPid)) throw new LockHeldError(heldPid); // 活锁
      try { unlinkSync(lockPath); } catch { /* 他实例已清理（并发夺位窗·下轮 wx 收敛） */ }
    }
  }
  throw new LockHeldError(readLockPid(lockPath) ?? -1); // 夺位竞态耗尽兜底（窗极小）
}
