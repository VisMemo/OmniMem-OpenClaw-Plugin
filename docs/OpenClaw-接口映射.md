# OpenClaw 接口映射

## 1. 当前接入点

本项目对齐的 OpenClaw 接入点如下：

### Plugin Manifest

- `openclaw.plugin.json`
- OpenClaw 会先用 manifest 校验配置，再加载运行时代码

### Hook 接口

Overlay 使用：

1. `before_prompt_build`
2. `agent_end`
3. `before_compaction`
4. `before_reset`

Memory 使用：

1. `before_prompt_build`
2. `agent_end`
3. `before_compaction`
4. `before_reset`

### Tool 接口

Memory 模式注册：

1. `memory_search`
2. `memory_get`

---

## 2. 为什么是这组接口

### `before_prompt_build`

这是 OpenClaw 当前推荐的 prompt shaping 接口。

它比 `before_agent_start` 更明确，因为：

1. session messages 已可用
2. prompt mutation 语义更清晰

### `agent_end`

用于对话结束后的自动写回。

### `before_compaction`

用于在压缩前做一轮补写，尽量减少遗漏。

### `before_reset`

用于 `/new` 或 `/reset` 前保留记忆。

### `memory_search / memory_get`

这是 OpenClaw 当前原生 memory 约定。

因此 replacement 模式必须优先兼容这两个名字。

---

## 3. 当前项目如何映射 OmniMemory SDK 语义

### Search

映射到：

1. `POST /retrieval`
2. 使用 `run_id`
3. 读取 `evidence_details`

### Read

`memory_get` 不存在真实文件系统路径，因此使用 synthetic path：

1. `omni:event:*`
2. `omni:entity:*`
3. `omni:item:*`

读取策略：

1. 先查本地 cache
2. event 时回查 explain/event
3. entity 时回查 entity timeline

### Ingest

映射到：

1. `POST /ingest`
2. `GET /ingest/sessions/{session_id}`
3. `GET /ingest/jobs/{job_id}`

---

## 4. 为什么没有改 OpenClaw core

当前项目默认优先兼容 OpenClaw 公开插件接缝（不强制改 core）。

因此：

1. 不扩 `memory.backend`
2. 不改 core prompt builder
3. 不改 core bootstrap 逻辑

这保证：

1. 上游快速更新时更稳
2. 用户已有 `MEMORY.md / memory/*.md` 不被破坏

同时，`Replacement` 提供可选手术 patch 脚本：

1. `npm run patch:status`
2. `npm run patch:apply`
3. `npm run patch:revert`

用于在高级场景下修复两处 core 语义冲突，但不改变“对外只有 Overlay/Replacement 两种模式”的产品分层。

---

## 5. 当前与 OpenClaw core 的边界

### 已能通过插件完成

1. 外部记忆召回
2. prompt augmentation
3. 自动写回
4. 原生 memory tool 契约兼容

### 仍属于后续增强点

1. system prompt 原生 memory 文案完全插件化
2. bootstrap memory 文件抑制
3. compaction flush 的正式委托能力

注意：

这些增强点应被视为 `Replacement` 的增强层，而不是新的第三种模式。
