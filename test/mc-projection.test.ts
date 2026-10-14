// ── obs 窗卡②：mc 失败计数投影单测 ──
// totalFailures 无条件累计（connected/degraded 两态都算）/lastFailureClass 分类串/
// lastFailureAt ISO 形。真 http server——不 mock 网络栈。
// mcProbe getter 即 healthz mc 段投影源（照 8713 power 段 readFailures 同构形）。

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { ConnectionManager } from "../src/server/app.js";

describe("ConnectionManager mc 失败计数投影（obs 卡②）", () => {
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

  function startServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<string> {
    return new Promise((resolve) => {
      const s = http.createServer(handler);
      servers.push(s);
      s.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
      });
    });
  }

  function newMgr(base: string, initialState: "connected" | "degraded") {
    return new ConnectionManager(base, {
      nodeId: "test-node",
      version: "test",
      initialState,
    });
  }

  it("connected 态失败 → totalFailures=1+分类串+ISO 时戳", async () => {
    const base = await startServer((_, res) => { res.statusCode = 401; res.end('{"error":"unauthorized"}'); });
    const cap = captureFailLogs();
    try {
      const mgr = newMgr(base, "connected");
      const ok = await mgr.checkHealth();
      assert.equal(ok, false);
      const p = mgr.mcProbe;
      assert.equal(p.totalFailures, 1);
      assert.ok(p.lastFailureClass?.startsWith("auth-rejected (HTTP 401)"), `got: ${p.lastFailureClass}`);
      assert.ok(p.lastFailureAt && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(p.lastFailureAt), "lastFailureAt 系 ISO 形");
    } finally { cap.restore(); }
  });

  it("连续两败 → totalFailures 递增到 2", async () => {
    const base = await startServer((_, res) => { res.statusCode = 500; res.end("boom"); });
    const cap = captureFailLogs();
    try {
      const mgr = newMgr(base, "connected");
      await mgr.checkHealth();
      await mgr.checkHealth();
      assert.equal(mgr.mcProbe.totalFailures, 2);
      assert.ok(mgr.mcProbe.lastFailureClass?.startsWith("http-500"), `got: ${mgr.mcProbe.lastFailureClass}`);
    } finally { cap.restore(); }
  });

  it("degraded 态失败也累计（无条件——23h 盲区缺口正面断言）", async () => {
    const base = await startServer((_, res) => { res.statusCode = 401; res.end('{"error":"unauthorized"}'); });
    const cap = captureFailLogs();
    try {
      // initialState degraded：现役 consecutiveFailures 只在 connected 态计数，
      // totalFailures 须两态都累计
      const mgr = newMgr(base, "degraded");
      await mgr.checkHealth();
      await mgr.checkHealth();
      assert.equal(mgr.mcProbe.totalFailures, 2);
    } finally { cap.restore(); }
  });

  it("成功路径零累计：totalFailures 保持 0+lastFailureAt null", async () => {
    const base = await startServer((_, res) => { res.end('{"ok":true}'); });
    const mgr = newMgr(base, "connected");
    const ok = await mgr.checkHealth();
    assert.equal(ok, true);
    const p = mgr.mcProbe;
    assert.equal(p.totalFailures, 0);
    assert.equal(p.lastFailureAt, null);
    assert.equal(p.lastFailureClass, null);
  });
});

function captureFailLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  return { lines, restore: () => { console.log = orig; } };
}
