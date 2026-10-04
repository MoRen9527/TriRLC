// ── 自研轻量测试 renderer（batch-03 件 2 V2 裁条·CTO 方案 A'）──
// 包 src/tui/ink/ink/root.js 的 renderSync（stdout 参数可注入=引擎原生测试挂点）
// +内存 fake stdout 帧缓冲 → 暴露 ink-testing-library 三原语最小面
// {frames, lastFrame(), rerender, unmount}（迁移成本=单行 import）。
// 边界（V2 重申）：零改动 src/tui/ink 引擎行为语义；本件=测试面非引擎面。
import { Writable, PassThrough } from 'stream';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { renderSync } from '../../../src/tui/ink/ink/root.js';
import type { ReactElement } from 'react';

// NODE_ENV=test → reconciler resetAfterCommit 走 onImmediateRender 直发路径
// （reconciler.js:214-222，绕 FRAME_INTERVAL_MS throttle）＝同步 lastFrame() 契约正门。
// node --test 每文件独立子进程，本置位不外溢他文件。
process.env.NODE_ENV ??= 'test';

export interface TestRenderer {
  /** 历次帧文本（stdout.write 捕获序） */
  frames: string[];
  /** 最近一帧（无帧时 undefined，与 ink-testing-library 行为对齐） */
  lastFrame(): string | undefined;
  rerender(node: ReactElement): void;
  unmount(): void;
}

export function render(node: ReactElement): TestRenderer {
  const frames: string[] = [];
  // fake stdout：内存帧缓冲；headless（非 TTY，免 alt-screen/鼠标序列路径）
  const fakeStdout = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(chunk.toString());
      callback();
    },
  }) as Writable & { columns?: number; rows?: number; isTTY?: boolean };
  fakeStdout.columns = 100;
  fakeStdout.rows = 24;
  fakeStdout.isTTY = false;

  const instance = renderSync(node, {
    stdout: fakeStdout,
    stderr: fakeStdout,
    // PassThrough：无 fd 句柄＝零环引用（默认 process.stdin 的 Socket 会扣住测试进程）
    stdin: new PassThrough(),
    exitOnCtrlC: false,
    patchConsole: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  // 自清钩：断言均在 render() 返回的同一 tick 内同步完成，下一宏任务自动
  // unmount——清 Spinner 等组件内部 interval/引擎定时器，防测试进程挂起
  // （被测件不 unmount 即泄漏内部 timer；组件卸载清理属引擎既有语义，非行为变更）。
  setImmediate(() => {
    try {
      instance.unmount();
    } catch {
      /* 已卸载/清理异常不阻断测试面 */
    }
  });

  return {
    frames,
    lastFrame: () => frames[frames.length - 1],
    rerender: (next: ReactElement) => instance.rerender(next),
    unmount: () => instance.unmount(),
  };
}
