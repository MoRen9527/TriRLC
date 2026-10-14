// ── obs 窗卡③：degraded 告警防抖单测 ──
// 边界：1 败不告警 / 2 败告警一次 / 3 败不重复 / 恢复重置可再告警 /
// notify 失败计数+下拍重试 / notify 异常同形 / 未注入=禁用零炸。
// mock notifyPost（同步 resolve）+可变行为真 http server。

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { ConnectionManager, type McAlarmPayload } from "../src/server/app.js";

describe("ConnectionManager degraded 告警防抖（obs 卡③）", () => {
  let servers: http.Server[] = [];

  beforeEach(() => {
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => s.close(() => resolve())),
      ),
    );
  });

  /** 可变行为 server：mode='fail'→401 / 'ok'→ok:true */
  function startSwitchableServer(): { base: Promise<string>; setMode: (m: "fail" | "ok") => void } {
    let mode: "fail" | "ok" = "fail";
    const base = new Promise<string>((resolve) => {
      const s = http.createServer((_, res) => {
        if (mode === "fail") {
          res.statusCode = 401;
          res.end('{"error":"unauthorized"}');
        } else {
          res.end('{"ok":true}');
        }
      });
      servers.push(s);
      s.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
      });
    });
    return { base, setMode: (m) => { mode = m; } };
  }

  function newMgr(
    base: string,
    calls: McAlarmPayload[],
    opts?: { notifyResult?: boolean; notifyThrow?: boolean; withNotify?: boolean },
  ) {
    return new ConnectionManager(base, {
      nodeId: "test-node",
      version: "test",
      initialState: "degraded",
      ...(opts?.withNotify === false
        ? {}
        : {
            notifyPost: async (p: McAlarmPayload) => {
              if (opts?.notifyThrow) throw new Error("mock-notify-boom");
              calls.push(p);
              return opts?.notifyResult ?? true;
            },
          }),
    });
  }

  const flush = () => new Promise((r) => setTimeout(r, 10));

  it("1 败不告警（防抖未达 2 拍）", async () => {
    const { base } = startSwitchableServer();
    const calls: McAlarmPayload[] = [];
    const mgr = newMgr(await base, calls);
    await mgr.checkHealth();
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(mgr.mcProbe.degradedFailures, 1);
    assert.equal(mgr.mcProbe.mcAlarmSent, false);
  });

  it("2 败告警一次+payload 形与零敏感断言", async () => {
    const { base } = startSwitchableServer();
    const calls: McAlarmPayload[] = [];
    const mgr = newMgr(await base, calls);
    await mgr.checkHealth();
    await mgr.checkHealth();
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(mgr.mcProbe.mcAlarmSent, true);
    const p = calls[0];
    assert.equal(p.source_seat, "trirlc-conn");
    assert.equal(p.target_daemon, "trimmc");
    assert.equal(p.target_seat, "m-duty-cos");
    assert.equal(p.urgent, true);
    assert.equal(p.title, "TRILC mc_link degraded");
    // D-46 同守：告警文本零敏感值面（无 token/URL 形态）
    const full = JSON.stringify(p);
    assert.ok(!full.includes("token"), "payload 不含 token 字样值面");
    assert.ok(!full.includes("http"), "payload 不含 URL 形态");
  });

  it("3 败不重复（告警一次后静默）", async () => {
    const { base } = startSwitchableServer();
    const calls: McAlarmPayload[] = [];
    const mgr = newMgr(await base, calls);
    await mgr.checkHealth();
    await mgr.checkHealth();
    await mgr.checkHealth();
    await flush();
    assert.equal(calls.length, 1);
  });

  it("恢复重置→再 degraded 可再告警", async () => {
    const { base, setMode } = startSwitchableServer();
    const calls: McAlarmPayload[] = [];
    const mgr = newMgr(await base, calls);
    // 第一轮：2 败→告警
    await mgr.checkHealth();
    await mgr.checkHealth();
    await flush();
    assert.equal(calls.length, 1);
    // 恢复：2 连胜→connected（recoverThreshold=2）
    setMode("ok");
    await mgr.checkHealth();
    await mgr.checkHealth();
    assert.equal(mgr.currentState, "connected");
    assert.equal(mgr.mcProbe.mcAlarmSent, false, "恢复重置 mcAlarmSent");
    assert.equal(mgr.mcProbe.degradedFailures, 0, "恢复重置 degradedFailures");
    // 第二轮 degraded：connected 3 败转 degraded（failThreshold=3）+degraded 内 2 败→第二次告警
    setMode("fail");
    await mgr.checkHealth();
    await mgr.checkHealth();
    await mgr.checkHealth();
    assert.equal(mgr.currentState, "degraded", "3 败转 degraded");
    await mgr.checkHealth();
    await mgr.checkHealth();
    await flush();
    assert.equal(calls.length, 2, "重置后可再告警");
  });

  it("notify 拒绝→计数+回滚下拍重试", async () => {
    const { base } = startSwitchableServer();
    const calls: McAlarmPayload[] = [];
    const mgr = newMgr(await base, calls, { notifyResult: false });
    await mgr.checkHealth();
    await mgr.checkHealth();
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(mgr.mcProbe.mcAlarmSent, false, "拒绝后回滚可重试");
    assert.equal(mgr.mcProbe.notifyFailures, 1);
    // 下拍失败重试
    await mgr.checkHealth();
    await flush();
    assert.equal(calls.length, 2, "下拍重试");
    assert.equal(mgr.mcProbe.notifyFailures, 2);
  });

  it("notify 异常→同形计数+回滚", async () => {
    const { base } = startSwitchableServer();
    const calls: McAlarmPayload[] = [];
    const cap = captureConnLogs();
    try {
      const mgr = newMgr(await base, calls, { notifyThrow: true });
      await mgr.checkHealth();
      await mgr.checkHealth();
      await flush();
      assert.equal(calls.length, 0, "抛异常不记成功调用");
      assert.equal(mgr.mcProbe.notifyFailures, 1);
      assert.equal(mgr.mcProbe.mcAlarmSent, false);
      assert.ok(cap.lines.some((l) => l.includes("degraded alarm notify error")), "异常落日志");
    } finally { cap.restore(); }
  });

  it("未注入 notifyPost→零调用零炸（禁用面）", async () => {
    const { base } = startSwitchableServer();
    const mgr = newMgr(await base, [], { withNotify: false });
    await mgr.checkHealth();
    await mgr.checkHealth();
    await mgr.checkHealth();
    assert.equal(mgr.mcProbe.degradedFailures, 3);
    assert.equal(mgr.mcProbe.mcAlarmSent, false);
    assert.equal(mgr.mcProbe.notifyFailures, 0);
  });

  it("端到端：connected 3 败转 degraded→再 2 败告警（elif 不双计）", async () => {
    const { base, setMode } = startSwitchableServer();
    const calls: McAlarmPayload[] = [];
    const mgr = new ConnectionManager(await base, {
      nodeId: "test-node",
      version: "test",
      initialState: "connected",
      notifyPost: async (p) => { calls.push(p); return true; },
    });
    setMode("fail");
    // failThreshold=3：3 败转 degraded（转换那次计入 connected 分支）
    await mgr.checkHealth();
    await mgr.checkHealth();
    assert.equal(mgr.currentState, "connected", "2 败未达阈值");
    await mgr.checkHealth();
    assert.equal(mgr.currentState, "degraded", "3 败转 degraded");
    assert.equal(mgr.mcProbe.degradedFailures, 0, "转换点不双计");
    // degraded 态 2 拍→告警
    await mgr.checkHealth();
    await flush();
    assert.equal(calls.length, 0, "degraded 内 1 拍未达阈值");
    await mgr.checkHealth();
    await flush();
    assert.equal(calls.length, 1, "degraded 内 2 拍告警");
  });
});

function captureConnLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  return { lines, restore: () => { console.log = orig; } };
}
