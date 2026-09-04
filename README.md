# TriLC

> **命名锚定（2026-08-24，quad-migration v1.0）**：本模块叙事面已更名 **TriRLC**（元现实本地控制器，读 "Tri-R-L-C"），与 TriRMC 共用自研内核 agent-core。仓目录名 `TriLC`、bin/npm 名 `trilc` 为兼容面照旧（操作命令语境用旧名）。权威 alias 表：`../TriCompany/docs/registry/company-governance-state.md`

TriLC is the TriMetaverse Local Controller.

Responsibilities:

- run as a detached local runtime
- upgrade a consenting client into a node
- manage planner, tool bus, and local execution lifecycle
- keep task execution alive even if Tripilot is closed
- expose local workspace and execution context through neutral capability adapters

Stable OpenClaw baseline:

- vendor/openclaw: vendored stable OpenClaw source snapshot at version 2026.3.28
- this snapshot is the starting point for evolving OpenClaw into the TriLC local-domain controller

Planned modules:

- src/runtime: detached daemon shell
- src/local-node: node lifecycle and heartbeat
- src/task-runtime: task execution state
- src/planner: planning and replanning
- src/toolbus: local tools and capabilities
- src/context-adapter: local workspace and capability adapter
- src/wallet-upgrade: wallet and consent upgrade flow

## 中央连接面（LG-030 勘定 2026-09-04）

- 本 daemon（8711）经 `TRIMC_BASE_URL`（User env+daemon cmd 双注入，默认覆盖 127.0.0.1:8710 dev 形态）直上送**中央面**（sg 47.245.122.61:8710）；heyuan TriRMC（8.155.54.79）为 R 面周平面迁移自治执行点——两者职责分属两节点。
- 连接面变更须 CEO 明令（D-17 在册）；代码默认值=dev 同机形态仅限开发。

- 审计条款（LG-031）：M/R 面按承载语义连，非按面名连。
