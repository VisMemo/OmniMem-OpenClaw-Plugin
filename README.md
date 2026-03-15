# OmniMem-OpenClaw-Plugin

OmniMemory 的 OpenClaw 可插拔插件仓库。

项目采用一个代码库、两个插件形态，并对外收敛为两种产品模式：

1. `Overlay`
   - 插件 id：`omnimemory-overlay`
   - 非破坏性外挂增强
   - 不接管 `plugins.slots.memory`
2. `Replacement`
   - 插件 id：`omnimemory-memory`
   - `kind: "memory"`
   - 接管 `plugins.slots.memory`
   - 可选叠加 prompt/bootstrap patch，但 patch 不是第三种模式

## 当前结论

当前仓库已经完成：

1. 双插件骨架与共享 runtime
2. 标准本地可安装插件包
3. 安装 / 切换 / 卸载 / 回滚管理脚本
4. patch 工具链与 doctor 诊断
5. 本地 mock 集成测试
6. 真实 OpenClaw Gateway smoke
7. 真实 Omni API smoke
8. Agent 托管安装 skill

真实 smoke 的最新结论是：

1. `Overlay` 可真实写入并召回 OmniMemory
2. `Replacement` 可真实接管 `memory_search / memory_get`
3. 两种模式都已经证明“可安装、可加载、可联动”
4. 但当前 Omni 检索的 `run_id` 语义还不能被视为严格 session 隔离，`Replacement` 仍应视为高级实验替换版

## 快速开始

标准安装：

```bash
openclaw plugins install /abs/path/to/OmniMem-OpenClaw-Plugin/plugins/omnimemory-overlay
openclaw plugins install /abs/path/to/OmniMem-OpenClaw-Plugin/plugins/omnimemory-memory
```

推荐使用统一管理脚本：

```bash
cd OmniMem-OpenClaw-Plugin
node scripts/omnimemory-manage.mjs install --mode overlay
node scripts/omnimemory-manage.mjs switch --mode replacement --apply-patch
node scripts/omnimemory-manage.mjs rollback
node scripts/omnimemory-manage.mjs uninstall --mode replacement --revert-patch
```

常用验证命令：

```bash
cd OmniMem-OpenClaw-Plugin
npm run packages:sync
npm run doctor
npm test
npm run test:integration
npm run smoke:standard-install
```

可选 patch：

```bash
cd OmniMem-OpenClaw-Plugin
npm run patch:status
npm run patch:apply
npm run patch:revert
```

## 仓库结构

```text
OmniMem-OpenClaw-Plugin/
  docs/
  plugins/
    omnimemory-overlay/
    omnimemory-memory/
  scripts/
  skills/
  src/
  test/
  TODO.md
```

## 主要文档

1. [使用说明](./docs/使用说明.md)
2. [实现原则](./docs/实现原则.md)
3. [OpenClaw 接口映射](./docs/OpenClaw-接口映射.md)
4. [当前限制与后续工作](./docs/当前限制与后续工作.md)
5. [Agent 托管安装说明](./docs/Agent托管安装说明.md)

## 当前推荐口径

1. 默认推荐 `Overlay`
2. `Replacement` 面向高级用户和实验替换场景
3. patch 只作为 `Replacement` 的增强层
4. 在严格会话隔离要求下，需先进一步确认 Omni 的 session 检索语义
