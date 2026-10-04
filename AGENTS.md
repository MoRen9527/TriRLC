# TriRLC Agent Rules

## Module Role

- TriRLC 是本地域控制器。
- 它负责 detached local runtime、本地节点升级、planner、tool bus 和本地执行生命周期。
- 当商业模式涉及本地域执行、节点升级或本地工具能力时，必须考虑本模块。

## Strategy Delegation

- 总商业模式、是否把本地域作为当前实验重点、与服务域或移动端的边界，先咨询 `TriMetaverse/BusinessStrategy`。

## Local Fact Sources

- 产品事实：`README.md`
- 代码事实：`src/runtime/`、`src/local-node/`、`src/planner/`、`src/toolbus/`、`src/context-adapter/`

## Current Registries

- `TriRLCBusinessStrategyRegistry`
- `TriRLCProductRegistry`
- `TriRLCCodeRegistry`

当前 registry agent canonical discovery 位于 `TriRLC/.github/agents/`。同名中央 discovery 文件不应在 `TriMetaverse/.github/agents/` 并行保留；中央只通过 manifest 和 registry closeout 工作流路由本模块 registry。

## Update Discipline

- 当前事实不足时应标为待确认，尤其不要虚构本地域节点成熟度。
