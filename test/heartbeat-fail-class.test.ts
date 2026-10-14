// ── obs 窗卡①：postHeartbeat 失败分类日志单测 ──
// 四态实锚：401→auth-rejected / 404→endpoint-missing / timeout→timeout /
// 2xx ok:true→true 且零失败日志。onFailureClass 回调同步收分类串。
// 真 http server（127.0.0.1:0 随机口）——不 mock 网络栈，验端到端行为。

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { postHeartbeat } from "../src/server/app.js";

describe("postHeartbeat 失败分类（obs 卡①）", () => {
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

  function captureFailLogs(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    return { lines, restore: () => { console.log = orig; } };
  }

  const hb = {
    nodeId: "test-node",
    state: "connected",
    queueSize: 0,
    uptimeSeconds: 1,
    agentCoreVersion: "test",
  };

  it("401 → auth-rejected 分类+false+回调收串", async () => {
    const base = await startServer((_, res) => { res.statusCode = 401; res.end('{"error":"unauthorized"}'); });
    const seen: string[] = [];
    const cap = captureFailLogs();
    try {
      const ok = await postHeartbeat(base, hb, 2000, (c) => seen.push(c));
      assert.equal(ok, false);
      assert.ok(seen[0].startsWith("auth-rejected (HTTP 401)"), `got: ${seen[0]}`);
      assert.ok(cap.lines.some((l) => l.includes("heartbeat failed: auth-rejected (HTTP 401)")));
      assert.ok(cap.lines[0].includes("[trilc:conn] "), "日志带 trilc:conn 前缀");
      assert.ok(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(cap.lines[0]), "日志带 ISO 时戳");
    } finally { cap.restore(); }
  });

  it("404 → endpoint-missing 分类", async () => {
    const base = await startServer((_, res) => { res.statusCode = 404; res.end("no route"); });
    const seen: string[] = [];
    const cap = captureFailLogs();
    try {
      const ok = await postHeartbeat(base, hb, 2000, (c) => seen.push(c));
      assert.equal(ok, false);
      assert.ok(seen[0].startsWith("endpoint-missing (HTTP 404)"));
    } finally { cap.restore(); }
  });

  it("超时 → timeout 分类（短超时挂起 server）", async () => {
    const base = await startServer(() => { /* 永不响应 */ });
    const seen: string[] = [];
    const cap = captureFailLogs();
    try {
      const ok = await postHeartbeat(base, hb, 80, (c) => seen.push(c));
      assert.equal(ok, false);
      assert.ok(seen[0].startsWith("timeout (80ms)"), `got: ${seen[0]}`);
    } finally { cap.restore(); }
  });

  it("2xx ok:true → true 且零失败日志（成功静默）", async () => {
    const base = await startServer((_, res) => { res.end('{"ok":true}'); });
    const seen: string[] = [];
    const cap = captureFailLogs();
    try {
      const ok = await postHeartbeat(base, hb, 2000, (c) => seen.push(c));
      assert.equal(ok, true);
      assert.equal(seen.length, 0);
      // 断言收窄到失败分类日志精准语义（test runner/模块杂音可进 console.log 但不含分类行）
      assert.equal(cap.lines.filter((l) => l.includes("heartbeat failed")).length, 0);
    } finally { cap.restore(); }
  });

  it("2xx ok 假 → business-reject 分类", async () => {
    const base = await startServer((_, res) => { res.end('{"ok":false}'); });
    const seen: string[] = [];
    const cap = captureFailLogs();
    try {
      const ok = await postHeartbeat(base, hb, 2000, (c) => seen.push(c));
      assert.equal(ok, false);
      assert.ok(seen[0].startsWith("business-reject"));
    } finally { cap.restore(); }
  });

  it("2xx 非 JSON → bad-body 分类", async () => {
    const base = await startServer((_, res) => { res.end("not-json"); });
    const seen: string[] = [];
    const cap = captureFailLogs();
    try {
      const ok = await postHeartbeat(base, hb, 2000, (c) => seen.push(c));
      assert.equal(ok, false);
      assert.ok(seen[0].startsWith("bad-body"));
    } finally { cap.restore(); }
  });

  it("连接拒 → network-ECONNREFUSED 分类", async () => {
    // 占一个口然后立即关闭 → 该口无人监听 → ECONNREFUSED
    const base = await new Promise<string>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(`http://127.0.0.1:${p}`));
      });
    });
    const seen: string[] = [];
    const cap = captureFailLogs();
    try {
      const ok = await postHeartbeat(base, hb, 2000, (c) => seen.push(c));
      assert.equal(ok, false);
      assert.ok(seen[0].startsWith("network-"), `got: ${seen[0]}`);
    } finally { cap.restore(); }
  });
});
