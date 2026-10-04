# TriRLC Code State

## Repository Map

- `src/server/`：HTTP API server（TriMMC 兼容）— **CTO-008-M 新增**。`app.ts` 提供 ConnectionManager（3 次失败降级/2 次成功恢复状态机）+ 增强心跳（POST `/internal/v1/heartbeat`）+ 恢复回放（degraded→connected 自动触发 `_performReplay()`）+ `/healthz` `/internal/v1/agent` 端点。
- `src/event-queue/`：**NEW CTO-008-M M.1/M.3**。离网事件队列：`store.ts`（SQLite WAL 持久化，prepared statements, batch transactions）、`queue.ts`（`createEventQueue` 工厂：enqueue / getPendingForReplay / applyReplayResponse / expireOldEvents / getQueueSize）、`types.ts`（QueuedEvent / ReplayRequest / ReplayResponse 类型契约）。11 unit tests + 6 integration tests PASS。
- `src/localbus/`：**NEW CTO-008-M M.3**。`bus.ts` 提供 typed EventEmitter singleton（`localBus`）+ `publish()` helper。Phase 1 内存总线 → Phase 2 UDS/Named Pipe。事件类型：task:queued/running/succeeded/failed、node:connected/degraded/local、agent:event。
- `src/runtime/`：本地 detached runtime
- `src/local-node/`：节点生命周期和心跳
- `src/planner/`：规划与重规划
- `src/toolbus/`：工具总线
- `src/task-runtime/`：任务运行时
- `src/context-adapter/`：本地上下文与能力适配
- `src/contracts/`：类型契约
- `src/session-store/`：**2026-07-22 arch-trilc-daemon D4-D5 新增**。`store.ts`（SQLite WAL，schema v2 migration：`sync_status`/`last_synced_at`/`cloud_session_id`/`title` + `updateSyncStatus`/`markPendingSync`/`getPendingSyncSessions`/`getSessionByCloudId`）+ `types.ts`（SyncStatus 状态机：`local→pending→syncing→synced|error`）。37/37 单元测试 PASS。
- `src/cli.ts`：CLI 入口 + daemon 生命周期管理 — **2026-07-22 arch-trilc-daemon D1 新增**：`install-service`/`uninstall-service`（Windows Service via `sc.exe`）+ `install-regrun`/`uninstall-regrun`（Registry Run）+ 权限检测 + 平台检测 + 互斥检测 + 卸载清理逻辑。
- `vendor/`：外部基线快照

## Current Code Health

- 已有较清晰的本地域控制器骨架。
- **2026-07-17 CTO-008-M**：通信协议全线代码落地 + 测试通过（M.1-M.6 完成，M.7 收口中）：
  - M.1: `src/event-queue/` SQLite 事件队列 — 11 tests PASS
  - M.2: TriMMC replay 端点（TriMMC app.ts）— 6 集成测试覆盖
  - M.3: `src/localbus/` 内存 EventEmitter 总线
  - M.4: 增强心跳（TriMMC + TriRLC ConnectionManager）
  - M.5: 冲突仲裁（TriMMC `src/comm/arbitration.ts`）— 11 tests PASS
  - M.6: 端到端集成测试（enqueue→replay→arbitrate→apply）— 6 tests PASS
  - 全量：27 tests / 0 fail（TriRLC）；11 tests / 0 fail（TriMMC 仲裁模块）
- 2026-07-16：CTO-008-P 冒烟测试通过 — healthz、代理到 TriMMC（失败→fallback→本地 agentLoop）、clean shutdown 均验证 OK
- **2026-07-22：arch-trilc-daemon 交付（CTO 门禁 APPROVE）** — CLI daemon 注册（`install-service`/`uninstall-service`/`install-regrun`/`uninstall-regrun`，8/8 代码审查验证项通过）+ session-store schema v2 migration（`sync_status`/`last_synced_at`/`cloud_session_id`/`title`，37/37 新增单元测试 PASS）+ 已有回归 28/28 PASS。SyncStatus 默认值统一为 `'local'`。待后续树：arch-trilc-tray（Tray 实现）、arch-trilc-sync（sync-engine+端点）、arch-trilc-msi-e2e（MSI+集成验证）。
- 依赖 `@trimetaverse/agent-core` (file:../TriMMC/packages/agent-core) + `trimodel`
- 2026-05-26 已补齐独立 git 仓、根级 `.gitignore` 与本地 CodeGraph 标配。
- 尚未建立 registry 级代码健康评分和 git 健康摘要。

## Change Tracking Baseline

- 关键关注 runtime、planner、本地节点和 capability adapter 的结构变化。

- 涉及具体项目代码仓库时，技术侧文档基线应按 `docs/engineering/DESIGN.md`、技术版 `ROADMAP.md`、技术版 `STATE.md` 以及 `docs/execution/<workstream>/<phase>/PLAN.md`、`SUMMARY.md`、`VERIFICATION.md` 维护；若缺失，应视为待补齐的技术或执行层缺口。

## Local CodeGraph Index

- 2026-05-24 已由 CTO 小狄技术线完成本地 CodeGraph 试点初始化，并由本模块 CodeRegistry 接管索引摘要。
- 索引范围为仓根干净索引，当前 `.gitignore` 排除 `.codegraph/`、`.cursor/`、`node_modules/`、`vendor/`、构建产物和环境文件；`vendor/openclaw/` 只作为外部参考快照，不进入本模块 CodeGraph 事实。
- 当前摘要：10 files，39 nodes，48 edges，language `typescript`。
- 当前 pending changes 为 `0/0/0`；`.codegraph/` 只作为本地缓存，不作为仓库真源提交。

## Git Health

- 2026-05-26 已补齐独立 git 仓基线；后续由本模块 CodeRegistry 继续维护分支、热区和 dirty worktree 摘要。

## Quality Risks

- 本地域控制器与移动端、入口层的边界容易被过度乐观表述。
- 若不持续区分 `TriRLC` 的本地 runtime / planner / tool bus 职责与 PC 端软件层的工作台职责，后续很容易混淆本地执行面和桌面入口面。
- 若不持续更新 planner 和 node lifecycle 的成熟度，后续人格型 agent 会高估执行能力。

## Known Issues / Follow-ups

- **2026-07-25 工程纪律登记（AgentEvent 消费约束）**：`@trimetaverse/agent-core` 的 `agentLoop` 每轮模型回复会 emit 两类事件——`content_delta`（每个 stream chunk 一次，增量文本）与 `assistant_message`（整轮结束一次性，完整聚合 content + tool_calls）。**二者在 content 维度上语义重叠且互斥**：`assistant_message.content` 即同一轮 `content_delta.delta` 的聚合，下游消费者二选一，禁止同时累加/转发，否则会产生重复文本（如 "ABC"+"ABC"）。`tool_calls` 维度有**两个同源事件**：`assistant_message`（聚合 `tool_calls[]`）与独立的 `tool_call`（单调用事件，携带同 id/name/arguments）。下游必须按 **tool_use id 去重**（先到先处理、后到跳过），禁止双源同时开 tool_use block / 转发 tool_calls delta，否则客户端会看到重复的 `content_block_start`（同 id）或重复的 tool_calls chunk。两个 converter（`anthropic-stream.ts` / `openai-stream.ts`）均已用 `processedToolUseIds: Set<string>` 落地该去重（每轮 `request_start` 清空）。正确兜底范式参考 `src/server/app.ts` `/internal/v1/sessions/{id}/stream` 中的 `if (am.content && !deltaContent)` 写法——仅在未收到任何 delta 时用 `assistant_message.content` 兜底。本次 `/v1/messages`、`/chat/completions` 流式与 JSON 四处消费点违反该约束的 Bug 已在修复中；本条纪律作为防复发基线长期生效。
- **2026-07-25 review 偏差登记（ink 依赖）**：TriRLC 实际依赖 `ink@^5.2.0`（npm 公开包），CTO 历史技术 review 中"自研 Ink vendor 吸收"未落地。当前以 npm 公开包依赖运行，不阻塞本次 AgentEvent 重复文本修复；后续若进入正式宿主切换或供应链收敛阶段，需另行评估是否进入 vendor 吸收或锁定包指纹，作为 follow-up 待办。

## Phase 1 配置平面改造（W30，cpo-trimodel-deployment）

### Key 缓存模块（`src/config/key-cache.ts`）

- **★ Phase 1 新增**：从 TriModel 配置平面 API 拉取 Provider Key
- 持久化到磁盘（S3 安全：600 权限），Phase 2 预留 KeyStorage 抽象用于 S2 加密
- 刷新策略：15 分钟定时刷新 + 启动时 0-60s 随机 stagger（防惊群）
- TTL：24 小时，过期后若无缓存则 chat 降级不可用
- 离线容错：fetch 失败时使用磁盘缓存；无缓存时 chat disabled
- API：`initKeyCache()`, `getKeyCache()`, `stopKeyCache()`
- 密钥日志脱敏：`sanitizeKey()` → 仅显示前 5 字符 + `****`

### HTTP 优先模型发现（`src/server/app.ts` `getAvailableModels()`）

- **★ Phase 1 改造**：从同步 import library 改为 `async` HTTP 优先
- 优先级：TriModel API (`GET /v1/models`) → library fallback (`createModelClient().listModels()`) → 硬编码兜底
- TriModel API 不可用时自动降级，不阻断 TriPilot 启动
- 1 分钟内存缓存（`MODEL_CACHE_TTL_MS = 60_000`）

### Mirror 模块（`src/mirror/`）

- **★ Phase 1 新增**：`pusher.ts`（推送引擎）+ `types.ts`（类型契约）
- 用于 TriRLC → TriMMC 云端会话数据镜像推送

### Agent Contract Resolver（`src/config/contract-resolver.ts`）

- Agent Contract V2 YAML 加载与五件套拼接，运行时根据 agent_id 注入对应身份
- `loadAll()`：遍历 source-agents 子目录，加载所有 `*.contract.yaml`
- `loadOne()`：解析单个 contract → 读取 soul / agent_body / agent_frontmatter / memory / colleagues / social → 组装 system prompt
- `watchAndReload()`：监听文件变更并热重载
- **2026-08-01 P0-1 修复**（colleagues_social schema 兼容）：Resolved 原本只识别 YAML paths 中独立 `colleagues` + `social` 字段；TriCompany V2 contract 部分使用合并字段 `colleagues_social`。`loadOne()` 新增归一化逻辑：若 paths 包含 `colleagues_social`，自动填充缺失的独立字段（`colleagues` / `social`），保持向后兼容两种格式。

### env var 变更

| 变量 | 说明 |
|------|------|
| `TRIMODEL_API_URL` | TriModel 配置平面 API 地址（默认 `http://127.0.0.1:3333`） |
| `TRIMODEL_API_TOKEN` | TriModel API 认证 token |

## 初始化状态机（W33，init-collab I1 — commit 186296a）

### 链路进度状态机（`src/company/init-chain.ts`）

- **I1 新增（init-collab-i1-statemachine）**：七态链路状态机 `UNINITIALIZED → SELFCHECK → ONBOARDING → PROJECT-LINK → SYNC → CONFIRM → READY`，与公司态 `CompanyInitState` 分离独立持久（`{dataDir}/company/init-chain.json`）。
- 真 tmp→rename 原子写 + 校验读回；`eventSeq` 单调递增；无任何 git 操作（与 init-state.ts REQ-019 隐患区分，不复刻）。
- 断点续跑：daemon 启动 `load()` 恢复帧；`transitionTo()` 发布 `init:chain-changed`（事件帧 = 状态文件投影，eventSeq 同帧）。
- I1 真实动作仅 `uninitialized→selfcheck`（启动转移，不自动探测）；其余转移由后续树端点驱动。
- 护栏延续：`src/company/session-initializer.ts` 与 TriMMC 同源文件 diff 零行；`init-state.ts` diff 零行。

### 自检（`src/company/init-selfcheck.ts`）

- 五探测：healthz / tripilot（被动观察计数）/ trimodel / tristaciss / plane-hint-probe（第五探测构造 TriPilot 形态会话）。
- summary 规则：任一 fail（blocked 级）→ blocked；仅 degraded → degraded；全 ok → pass。401/403/unauthorized = 认证失败族唯一 blocked 类（网络不可达 = degraded）。
- 防重入：运行中再触发 → `{ conflict: true, runId }`（端点 409 同 runId）。
- 事件族：`init:selfcheck-started/progress/finished`（均经 localbus publish 同通道）。
- **I2 A' 裁决（CTO 2026-08-14）**：executeSelfcheck 完成路径加自动推进——summary ∈ {pass, degraded} 且链态 selfcheck → `transitionTo('onboarding', 'daemon')`；发布顺序 = selfcheck-finished 先、chain-changed 后（入口先看自检结果再切选择界面）；blocked 不推进（诊断卡保留，重跑幂等）；`getState()==='selfcheck'` 条件即幂等守卫（onboarding 态重跑无转移无事件）。

### I1 端点（`src/server/app.ts`）

- `GET /internal/v1/init/chain/status`（只读投影 + 诊断卡数据源）
- `POST /internal/v1/init/selfcheck/run`（202 + 防重入 409）
- 启动 load + `uninitialized` 自动转 selfcheck（不自动探测）
- I1 同批修复：A1（TRILC_ENV_FILE + dataDir 相邻 .env 候选）、A2（tool_result SSE 载荷映射）、A3（C13 门卫收紧）、tasks/submit 提交计数钩子、key-cache fetch 状态跟踪。

## 公司面装配升级（W33，init-collab I2 — 本树，commit 见 tree-op i2-2 checkpoint）

### 装配执行体（`src/company/init-assemble.ts`）

- **I2 新增**：`POST /internal/v1/init/assemble` 端点执行体（daemon 单执行体；两入口只发指令，零本地执行）。
- 校验先行（400 族）：ceoName 必填（trim 1..64）、selections ≥1（A4 0 人拦截）、roleId 形状 + 岗位目录成员双校验（白名单逃逸直接拒绝）、去重、name 必填；阶段门禁 422 `{ chainState }`；防重入 409 `{ busy: true }`；<5 岗 warning 不拦截（CEO 裁决口径）。
- 阶段门禁口径（i2-1 §一.2 字面 + CTO A' 裁决 2026-08-14）：仅 `chainState === 'onboarding'` 放行，其余（uninitialized / selfcheck / project-link+）422 `{ chainState }`。selfcheck→onboarding 推进点在 init-selfcheck.ts executeSelfcheck 完成路径（见下节），不在本端点。
- 预写段：白名单落点（`.claude/agents/<roleId>.md` / `docs/registry/company-state.json` / `docs/registry/business-state.md` / `AGENTS.md`）逐文件 tmp→rename + `.bak` 备份目录（`{dataDir}/company/assemble-bak/<runId>/`）；任一失败 → .bak 恢复 + 删新增文件 + 500 `{ rollback }`。
- 提交段：`CompanyInitState.save({ state:'initialized', ... })` → `InitChain.transitionTo('project-link', entry)`（公司态先、链路态后；save 成功但 transition 失败不回滚文件，幂等重试路径承接）。
- 幂等重试：公司态已 initialized 且链路态仍 onboarding/selfcheck → 跳过文件段与 state save，校验员工一致（不一致 409 `employees_mismatch`）后补 transition。
- 事件：`init:step-event` assembling / assembled / assemble-failed；chain-changed 由 transitionTo 自动发布。
- 既有真实内容不覆盖：`business-state.md` / `AGENTS.md` 缺失才写占位，存在即 preserved（响应报告）。
- 同包断点续跑端点逻辑：`getOnboardingStateProjection()`（只读投影，progress.ceoName 优先）+ `validateProgressUpsert()` / `upsertOnboardingProgress()`（经 `CompanyInitState.save({ progress })` 机制沿用，init-state.ts 零改动）。
- init 模式路由：`buildInitModeSystemPrompt(chainState)`（链态 ∈ {selfcheck, onboarding, project-link, sync, confirm} 且无 client systemPrompt 时替代 defaultSystemPrompt；含 init 端点指令面 + 零本地执行措辞）。

### I2 端点增量（`src/server/app.ts`）

- `GET /internal/v1/init/role-catalog`（contract-resolver `getRoleCatalog()`；resolver 未初始化/roster 缺失 → 503 不开天窗）
- `POST /internal/v1/init/assemble`（校验 → 执行 → 200/400/409/422/500）
- `GET /internal/v1/init/events`（daemon 级 init:* SSE 通道；无重放缓冲 = 断连重拉 status；25s keep-alive）
- `GET /internal/v1/init/onboarding/state` + `POST /internal/v1/init/onboarding/progress`（REQ-016 断点续跑真源）
- tasks/submit init 模式路由（无显式 systemPrompt + 链态 ∈ init 集 → init bootstrap + 周平面提示恒一次）

### role-catalog 数据源（`src/config/contract-resolver.ts`）

- `DEFAULT_SELECTED_ROLES` 常量（D1 决策 2026-08-14 CPO 确认）：ceo-chief-of-staff / full-stack-developer / chief-administrative-officer / chief-human-resources-officer / chief-technology-officer。
- `getRoleCatalog()`：roster 主键 + 合同 identity 面（roleName=identity.role、oneLinePositioning=identity.description、isGovernance=tier==='C-suite'、defaultSelected=常量）。
- `loadEmployeeRoster()` 路径候选扩展：`<sourceRoot>/docs/registry/` 与 `<TriCompany 根>/docs/registry/`（真源路径）。

### 叙事态下线（i2-2 §五，同 release 一次性）

- 删除 `src/company/onboarding.ts`（Step1-5 叙事 prompt 整体下线）
- 删除 app.ts heartbeat 叙事 onboarding agent 注册块 + cli.ts `hb_company-onboarding` auto-resume 分支
- ONBOARDING 阶段驱动 = 装配端点 + 事件流，无叙事 agent 并存路径

### 前置项与契约修正（i2-2 落地）

- I1 前置强制项③：`init-chain.ts load()` 区分 ENOENT（静默默认帧）vs 解析错（`.corrupt` 备份 + console.error + 默认帧），单测三件套覆盖。
- 契约修正⑧：`init-selfcheck.ts` trimodel 认证失败 detail 用 `ks.lastFetchError` 实际错误串（截断 120）。

### CLI 文本化流程（`src/company/init-cli-flow.ts`）

- trilc chat 启动时 chain/status 呈初始化阶段 → 文本化流程（selfcheck 诊断卡 blocked 置顶 + 组合规则注记 → 编号多选（默认 D1 五岗）→ CEO 名/员工名问答（REQ-016 已答不重复问）→ 汇总确认 → assemble 提交，entry=trilc-chat）。
- 员工 `--agent` 会话路径不动；流程只渲染 + 发 daemon 端点指令。

### 测试与冒烟

- 单测：init-chain（load 三件套 + 既有 8）/ init-selfcheck（detail 实际错误串断言更新 + A' 自动推进四用例：pass 转移 / degraded 转移 / blocked 不转移 / onboarding 重跑无转移）/ init-assemble 14 用例（校验矩阵、逃逸拒绝、422/409 门禁、回滚注入、幂等重试、事件帧一致、preserved、progress roundtrip、init 模式矩阵）/ contract-resolver（getRoleCatalog 2 用例）/ tasks-submit-weekly-hint（init 模式路由 1 用例）。
- 全量基线：340/341（1 fail = test/tui/components.test.ts ink-testing-library 环境缺口，r19 基线既有非本树引入）。
- 活体冒烟：TRILC_DATA_DIR 显式隔离实例 8726（候选 A 轮）+ 8727（A' 轮）全链 PASS。A' 轮实证：selfcheck 完成（degraded）→ 链态自动 onboarding（chain-changed from=selfcheck to=onboarding sourceEntry=daemon，SSE 序 selfcheck-finished 先于 chain-changed）→ assemble 200（响应与 §一.5 契约字面一致，无 advancedFromSelfcheck）→ 工作区白名单 8 产物 → 重入 422 → 8711 全程未扰动。

## 项目面注册点 + link/claim/inspect（W33，init-collab I3 — commit 71cccc9 独占四文件；共享文件 init-chain.updateProjectLink / app.ts 三端点 / bus.ts 事件族 / init-cli-flow 文本流程随 44c82a1 合并提交，i3-4 小狄终审放行）

### 注册点（`src/project/project-registry.ts`）

- 落点 `%LOCALAPPDATA%\trilc\project-registry.json` 固定路径（不随 TRILC_DATA_DIR 覆盖）；`TRILC_PROJECT_REGISTRY` env 仅测试隔离。文件不存在 → 默认帧（内置预置表 + 空运行态），惰性首写才落盘（符合设计）。
- schema（i3-1 §一冻结，I4 并行依据）：`{ schemaVersion: 1, activeProjectKey, projects: { <key>: { repoUrl, mainCheckoutPath, hasNpmFileDeps, defaultBranch, worktrees[] } } }`；worktrees 主键 = 绝对路径 + gitdir（同键幂等刷新、键冲突拒绝）。
- 真 tmp→rename 原子写 + 读回校验（schemaVersion + activeProjectKey）；内存态缓存（daemon 热更新源，link/claim 同请求内可见）。
- 项目仓注册表合并同文件：MVP 内置预置表（TriMetaverse 单条目；repoUrl 恒预置保白名单完整性，hasNpmFileDeps/defaultBranch 文件可覆盖 = 现场纠偏安全阀）。**生效时机：冷启动生效**（daemon 内存态缓存优先；运行中改文件需重启 daemon——i3-3 观察项 b 裁决：文档注明，不修）。
- 惰性清理（幽灵路径）：读取时逐项 existsSync(path)+existsSync(gitdir)，无效项登记移除、不删磁盘（物理资产保留可重新认领）。

### link/claim/inspect 执行体（`src/project/project-link.ts`）

- `POST /internal/v1/projects/link` 六步原子序同一请求：检测（形态判别 absent/empty-dir/worktree/git-repo/non-git-dir）→ 关联判定（remote origin URL 白名单规范化比对：https/ssh 同仓等价、去尾 .git、scp 形态）→ hasNpmFileDeps 门禁（拒绝自动 add）→ 认领（worktree 形态 gitdir 属主命中 → 只登记绝不重复 add）/ 建立（local: `worktree add -b project/<key>`；github: clone → defaultBranch checkout → setMainCheckout → 转本地链路）→ 登记去重 + `git worktree list` 交叉验证 → 链态快照 + 内存态热更新。失败分类十类 + 回滚（`worktree remove` 非 --force，全仓禁用 --force；链态失败 → 注册点回滚 + worktree remove）。防重入 409 busy。
- 链态门：link/claim 仅 `chainState=project-link`，其他 409 `{ chainState }`；inspect 只读不受门禁。本树零 transitionTo 转出（→sync 归 I4）。
- `POST /internal/v1/projects/claim`：打开文件夹认领（§4a 同构，零 git 写）。
- `GET /internal/v1/projects/inspect?path=`：识别分流三分类 managed-worktree / project-clone / unlinked。
- SSE 事件族（经既有 /internal/v1/init/events 通道）：`init:project-link-started/progress/finished`（step 枚举 detect/match/gate/claim/clone/worktree-add/register/chain-update；失败帧带 classification）；finished = chain/status 投影同帧。HTTP 语义：同步执行返回 200 完整结果（契约 202 字面落地调整，SSE 帧实时发布体验等价，i3-4 终审认可）。
- git 单执行体：`execFile` 参数数组无 shell（OBS-20260814-002）；克隆凭据走 git 系统凭据管理器，代码零密钥。
- 契约落地差异（i3-4 终审标注）：GitHub 源 match 先行于 detect（克隆默认落点依赖 key，语义不变）；lazyCleanup gitdir 校验落地为 existsSync（MVP 口径）。
- 已知观察项（i3-3 单列、i3-4 裁决）：github clone 期间无中间进度帧（362M 慢传输下向导无反馈，execFile 退出回调模型；600s timeout + clone-failed 分类兜底）——挂后续小树修（流式 stderr 进度解析 + 心跳帧），不阻塞 I3 收官。

### 测试与基线

- 单测 30 例：project-registry 12（原子写/主键去重/键冲突拒绝/惰性清理幽灵项/磁盘资产保留/幂等刷新）+ project-link 18（URL 规范化矩阵/链态门 409/六步全流程事件序/认领绝不重复 add/同目标重链走认领/门禁拒绝/非白名单拒绝/回滚两路径非 --force/防重入 busy/github 克隆链/claim 矩阵/inspect 三分类/--force 禁用断言/他主检出登记项不误判幽灵）。
- 全量基线：398/399（1 fail = test/tui/components.test.ts 环境缺口既有，不退化）。
- 活体（i3-2 CEO 机 8799 三重隔离 + i3-3 独立 8798/8797 双隔离；prod 8711 全程健康、prod 注册点零写入）：inspect 三分类、local 建立全链、同目标重链认领幂等、claim 200、github 白名单拒绝（evil 仓 422 零 clone）+ 真实克隆收敛（首试网络瞬时失败分类 clone-failed → 重试收敛）、门禁 422 零 add、branch-conflict 422、链态门 409、防重入 busy、SSE 八帧投影一致。两缺陷活体复测 PASS（同目标重链误拒 / crossValidateWithGit 他主检出误判幽灵）。

## 五维同步 + 协同确认（W33，init-collab I4 — 本树，commit 见 tree-op i4-2 checkpoint）

### bundle 契约（`src/company/sync-bundle.ts`，纯函数可单测）

- **I4 新增（init-collab-i4-five-dim-sync）**：五维 bundle schema 契约（TriMMC 接收侧 `src/config-sync/types.ts` 独立实现同一契约，跨仓共享包升级挂后续）。
- 密钥纪律（SEC-20260813-001）：递归拒绝 `api_key`/`apiKey`/`secret`/`token` 字段（任意深度、非空字符串值）；keys 维白名单 `provider`/`ready`/`fingerprint`/`baseUrl`（额外字段拒绝）；指纹 = SHA-256(材料).slice(0,8)（内存内计算即刻丢弃）；contentHash = 五维语义哈希（不含 bundleId/generatedAt/generatedBy 元字段——元字段每次生成必然不同，纳入会使幂等重跑判定恒失效）；generatedAt 单调 = max(now, 现存 + 1ms)。
- 测试门禁：构造含 `api_key: "sk-..."` 载荷 → 校验抛错；`assertNoSecretMaterial` 序列化全文断言（无 sk- 明文、无密钥字段名）。
- Phase D 契约冻结：L1-L4 确认卡类型（ConfirmCheckPayload/ConfirmResult，§六）——实现待 I3 收官解锁信号。

### 同步执行体（`src/company/init-sync.ts`）

- `POST /internal/v1/init/sync/run` 执行体（daemon 单执行体；两入口只发指令）：链态门 `{project-link, sync}` 否则 409；project-link+linked → 先 `transitionTo('sync')`；防重入 409 busy。
- 五维收集单维降级：company（无公司态 = 400 硬错误提示先开张）/ project（注册点主检出缺失 = 400；dev HEAD 读失败 = 422）为硬错误；model / keys / employees 失败 → 维段 `{status:'unavailable',reason}` 不阻塞全链。
- 幂等：本地文件已存在且五维语义 hash 未变 → 不重新生成、不换 bundleId（重跑 = 纯重推，`diff --cached --quiet` 无变更跳过 commit）。
- 写 + commit + push：原子写（tmp→rename）→ `git add docs/registry/init-sync/sync-config.json` → 固定身份 commit（`-c user.name="TriLC Init Sync" -c user.email="trilc@tri.company"`，D2）→ 双远端 push origin/sg-server dev；任一 push 失败 = 失败分类 + `phaseDetail.sync.status='failed'` 挂起（链态留 sync，重跑即重推）。
- 成功路径：`updateSync({status:'pushed',bundleId})` 快照 → `transitionTo('confirm')`（D1：转移门槛 = pushed）→ 事件族 `init:sync-started/progress（逐维三态）/finished/failed` + `init:step-event {phase:'sync',step:'pushed'}`（经既有 /internal/v1/init/events SSE，零新通道）。
- `GET /internal/v1/init/sync/status`：chainState + phaseDetail.sync + 本地 bundle 摘要 + remote（拉取 TriMMC config/sync/status，超时 3s 降级 null）。
- daemon 重启 re-sync 检查（§6.6 尾部）：链态 sync/confirm → 读本地 bundle + 调一次 sync/status（远程不可达静默）；只读 no-op，不自动 push/生成。
- init-chain.ts 增量：`updateSync`/`updateConfirm` 快照方法（SyncPhase/ConfirmPhase 字段已预留，零 schema 字段新增——门禁 2 同规）。

### I4 端点增量（`src/server/app.ts`）+ 入口渲染

- `POST /internal/v1/init/sync/run`（链态门 + 防重入 + 400/409/422/500 分类）+ `GET /internal/v1/init/sync/status`；启动 re-sync 检查挂 start()（只读）。
- localbus 事件族增 `init:sync-*` 四型（bus.ts）。
- trilc chat 文本流程（`init-cli-flow.ts`）：SYNC 阶段状态呈现 + 触发问答 + 五维结果行 + applied 收敛轮询（≤90s）；零本地执行（只渲染 + 发 daemon 端点指令）。
- TriPilot 初始化阶段卡（`TriPilot/src/extension.ts` + `media/main.js`）：syncStatus 数据面（sync/status 直通）+ initSyncRun 指令面（POST sync/run entry=tripilot）+ 逐维三态 live 行（init:sync-progress 事件驱动）+ applied 收敛徽标；零本地执行。

### 测试与基线

- 单测：sync-bundle 12 用例（校验矩阵/白名单/指纹/单调性/泄漏扫描）+ init-sync 16 用例（链态门 409/防重入 409/公司态 400/项目 400/422/五维降级矩阵/幂等重跑同 bundleId/内容变化新 bundleId/push 失败分类/事件序/git 固定身份/双远端/序列化无 sk-/status remote 降级/启动 re-sync 只读）。
- 全量基线：398/399（1 fail = test/tui/components.test.ts 环境缺口既有，基线 340/341 口径不退化；+58 含 i3-2 同批）。

### 返修包 R（i4-4 终审打回，2026-08-14 一批交付）

- **R1 devHead 自引用修复**（OBS-1）：`sync-bundle.ts` computeDimsContentHash 排除 project.devHead（自引用字段——每次成功 run 必 commit bundle 推进 HEAD，纳入使幂等重跑恒失效）；`init-sync.ts` assembleBundle 幂等路径返回 existing 原样 + writeBundleAtomic 跳过（字节不变 → 无 commit → 纯重推）；devHead 保留为 bundle 内诊断事实。TriMMC types.ts computeContentHash 同口径（两端一致）。
- **R2 L2 收敛语义**（OBS-6b）：`init-confirm.ts` computeL2 重写为同 dev 线语义（bundleHead 祖先/相等 localHead 且 local/fleet 等值或互为祖先 → 绿；分叉红勿确认；fleetHead 不可解析红+先 pull；降级 = bundleHead 祖先/相等，废止双值比较）；ConfirmCheckL2 增 bundleAncestor additive。
- **R3 L1 空集一致**（OBS-6a）：worktreePath 三方等值（含空集）判 ok + 确认卡空集提示注记；repoUrl/projectKey 维持非空 + 等值。
- 单测：+8 L2 矩阵 +2 L1 空集 +1 R1 幂等矩阵（仅 devHead 变化重跑不换 bundleId/不 commit/字节不变）；全量 427/426（1 fail = components.test.ts 既有缺口）。
- 环境面（OBS-7 扩展，非代码）：TriCompany/packages/agent-core 被同窗口清空（git 跟踪文件 57 个 + dist/node_modules），小全以 git checkout（索引恢复）+ npm install + rebuild 恢复，全量基线复绿。

### L1-L4 协同确认（`src/company/init-confirm.ts`，Phase D）

- **I4 Phase D 新增**：`GET /internal/v1/init/confirm/check`（按需计算，无后台常驻轮询）+ `POST /internal/v1/init/confirm`（服务端重算 check → readyForConfirm 门禁 409 附 check → `updateConfirm` 快照 confirmed + l1/l2/l3 → `transitionTo('ready')` → init:step-event confirmed）。
- L1 注册同一性：注册点 activeProjectKey/repoUrl/worktrees ↔ bundle.project ↔ TriMMC status.project 三面比对；worktree 路径用短指纹呈现（SHA-256.slice(0,8)，sync-bundle.ts `computePathFingerprint`）。
- L2 版本一致：本地 HEAD == bundle.devHead == fleetHead.commit；降级口径（remote null）→ 双值比较 + degraded: true。
- L3 写读闭环：applied.bundleId == 本地 bundle 文件 bundleId（sync commit 即探针）。
- L4 反向闭环：{ status: 'pending', note: '由首个协同工作承载' }（I5 树承载）。
- readyForConfirm = l1 && l2 && l3 全 ok（§2.8 验收口径：协同开启成功 = 三元素一致 + 一次确认）。
- TriMMC status 端点增 additive `project` 字段（applied project 维内容，L1 服务器侧事实源）。
- 单测 +11：三面一致全绿 / repoUrl 错误仓 / worktree 指纹呈现 + 服务器侧不一致 / fleet 落后 / 降级口径 / 未 applied 未就绪 / 本地 bundle 缺失 / confirm 成功转移 ready + 快照 + 事件 / 409 notReady 附 check / 409 chainState / 防重入并发。全量 409/410（1 fail 同既有缺口）。
- 两入口渲染：trilc chat CONFIRM 文本流程（L1-L4 呈现 + 红差异 + 诊断入口 + 确认问答）+ TriPilot 确认卡（三元素同显 + HEAD 徽标 + 未就绪提示 + 确认按钮门禁禁用态）；零本地执行。

### firstCollab 推进写入面（`src/company/init-first-collab.ts`，I5）

- **I5 新增（本树唯一代码增量，i5-1 §五）**：`POST /internal/v1/init/ready/first-collab`（internal localhost-only 面——daemon 只绑定 127.0.0.1）+ `init-chain.ts updateReady` 快照回写（与 updateSync/updateConfirm 同形态；零 schema 字段新增，ReadyPhase 三态 I1 已预留）。
- 链态门：chainState == 'ready' 否则 409 { chainState }；载荷 `{ status: 'triggered' | 'passed', note?: string }`（note 不持久——零 schema 新增纪律，证据面归 OP/验收执行本 verify/ 留档）。
- 合法转移：pending→triggered→passed 恰好 +1 步推进；跳级/回退 409 illegalTransition；同 status 重放幂等 no-op 200（不写状态、eventSeq 不增长）。
- transitionTo 转移表零改动（门禁 7）；两入口（TriPilot/trilc chat）零执行增量，只读呈现 firstCollab 状态（门禁 6）。
- 单测 +6：链态门 409 / 合法转移逐级 / 跳级拒绝 / 回退拒绝 / 重放幂等 / 载荷校验。全量 415/416（1 fail = test/tui/components.test.ts 环境缺口既有，基线 409/410 口径不退化）。

## Sources

- `../../src/runtime/`
- `../../src/local-node/`
- `../../src/planner/`
- `../../src/toolbus/`
- `../../src/context-adapter/`
- `../../src/config/contract-resolver.ts`
- `../../src/config/key-cache.ts`
- `../../src/mirror/`
- `../../src/server/app.ts`
