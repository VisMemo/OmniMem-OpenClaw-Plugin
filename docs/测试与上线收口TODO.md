# 测试与上线收口 TODO

## 1. 收口原则

### 1.1 产品口径先收死

当前对外口径只保留这几条：

1. `Overlay` 和 `Replacement` 是两种独立模式，不是可叠加能力
2. 一个 OpenClaw 实例同一时刻只应启用其中一种模式
3. `Overlay` 是默认推荐路径，优先级高于 `Replacement`
4. `Replacement` 定义为高级操作，只推荐在明确理解 patch / 版本约束的前提下启用
5. `Replacement` 只对明确声明支持的 OpenClaw 版本适配，不做“尽量兼容所有版本”的承诺
6. 当前硬隔离边界按 `tenant/account(api key)` 理解
7. 当前产品语义是：
   - `recall = tenant-global`
   - `ingest = session-scoped`
8. `sub-agent` 默认视为同一任务链的一部分，不单独承诺独立记忆人格

### 1.2 技术收口目标

这轮上线前，不再扩新功能，重点只做三类事情：

1. 把 `Replacement` 的运行时证据链补齐
2. 把 patch 相关风险从“源码级可工作”提升到“运行时已验证”
3. 把不推荐配置直接禁止掉，而不是依赖文档提醒

---

## 2. P0：本周必须补齐

### P0-0. Replacement 版本对齐与版本门禁

#### Owner / ETA

1. Owner：插件安装与 patch 维护
2. ETA：本周完成第一版门禁，发布前收口

#### 产品结论

`Replacement` 不是默认模式，而是高级操作：

1. 默认推荐用户先用 `Overlay`
2. 只有在 `Overlay` 方案无法满足需求时，才建议切到 `Replacement`
3. `Replacement` 不承诺“跟着任意 OpenClaw 最新版本自然兼容”
4. `Replacement` 只对明确列出的 OpenClaw 版本区间负责

#### 风险

当前 replacement 依赖 [src/replacement/patch-core.js](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/src/replacement/patch-core.js) 的源码锚点替换。即使 patch 本身是幂等的，也不能把它当成对上游任意版本的稳定抽象层。

如果没有版本对齐和门禁，会出现两类高风险：

1. patch 表面成功，但运行时语义漂移
2. patch 失败不够早，用户在“半工作状态”下继续使用 replacement

#### 设计方案

把“版本支持”做成显式机制，而不是隐式经验：

1. 增加一份支持矩阵配置
   - 例如：
     [docs/replacement-compatibility.md](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/docs/replacement-compatibility.md)
   - 明确写出：
     - 支持的 OpenClaw tag / semver 区间
     - 每个版本对应的 patch 状态
     - 是否经过运行时验证
2. `patch:status` 输出升级为版本门禁工具
   - 不仅检查 anchor 是否匹配
   - 还要检查当前 OpenClaw 版本是否在 allowlist 内
3. `patch:apply` 只对 allowlist 内版本放行
   - 对不支持版本直接报错退出
   - 不允许“尝试应用看看”
4. `doctor` 增加 replacement 版本健康检查
   - replacement 启用时，如果 OpenClaw 版本不在支持矩阵中，直接报红
5. 安装/管理脚本收口
   - `manage:replacement` 执行前先做版本检查
   - 不通过则拒绝安装

#### 验收标准

1. 用户在不受支持的 OpenClaw 版本上无法启用 replacement
2. `patch:status` 能明确输出：
   - 当前版本
   - 是否受支持
   - 哪些 patch 已验证
3. `doctor` 能明确把“replacement + 不支持版本”标成阻断项
4. 文档里能清楚区分：
   - `Overlay = 默认推荐`
   - `Replacement = 高级操作 + 版本锁定`

#### 收口动作

在这项完成前：

1. 不把 replacement 当成默认推荐安装路径
2. 不把 replacement 写成“自动兼容 OpenClaw 最新版”
3. 所有外部说明都必须明确写上“仅支持已验证版本”

#### 2026-03-21 运行时进展

1. 当前本地 OpenClaw `2026.3.14` 已进入 replacement 支持矩阵
2. `patch:status` 已能稳定输出：
   - 当前 OpenClaw 版本
   - 是否受支持
   - patch anchor 状态
   - 当前版本的支持说明
3. 已验证 fail-close 行为：
   - `patch:apply` 会阻断不在矩阵内的版本
   - `doctor` 会把“replacement 已启用 + 不受支持版本”标红
   - `manage ... --mode replacement --dry-run` 会直接拒绝不受支持版本
4. 支持矩阵文案已收口成“只写已经拿到的运行时证据”；`prompt injection` 和 `live smoke` 仍保持在后续 P0 项中，不提前宣称完成

### P0-1. Replacement 模式完整 hook E2E

#### Owner / ETA

1. Owner：插件测试 / smoke 脚手架
2. ETA：本周

#### 现状

当前 [openclaw-memory-slot.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/openclaw-memory-slot.integration.test.mjs) 只覆盖：

1. `memory_search`
2. `memory_get`

没有覆盖：

1. `agent_end`
2. `before_compaction`
3. `before_reset`

2026-03-21 运行时进展：

1. `agent_end` 已在真实 gateway E2E 中验证通过
2. 真实 `/new` 聊天路径下的 `before_reset` 目前仍未观测到稳定派发
3. 这个结论不是只靠 `omnimemory-memory` 自身判断得出的；额外挂载的 sidecar observer 插件在同一路径下也没有收到 `before_reset`
4. 因此当前更像是“真实 `/new` 路径的 before_reset 运行时证据缺失/未走通”，优先级仍保持 `P0`
5. 当前专用 E2E 已经把状态显式编码：
   - `agent_end` 真实 gateway E2E 为通过态
   - `/new -> before_reset` 相关两条测试暂时以 `known gap` 形式保留为 `skip`
   - 这样可以保证分支持续可回归，同时不丢失待收口证据点

#### 风险

`omnimemory-memory` 是通过 `plugins.slots.memory` 挂载的，不是普通插件入口。虽然实现里已经注册了这些 hook，见 [plugins/omnimemory-memory/index.js](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/plugins/omnimemory-memory/index.js)，但目前没有运行时证据证明 OpenClaw 会在 memory slot 路径下正常派发这些 hook。

#### 设计方案

新增一个 replacement 专用 E2E 文件：

1. 新文件：
   [test/replacement-hook.e2e.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/replacement-hook.e2e.integration.test.mjs)
2. 复用现有的 gateway smoke 脚手架：
   [scripts/lib/openclaw-smoke.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/scripts/lib/openclaw-smoke.mjs)
3. 启动方式改为：
   - 使用 `writeConfig(...plugins.slots.memory="omnimemory-memory")`
   - 不通过普通 `plugins.entries` 加载 replacement
4. 覆盖场景：
   - `agent_end` 触发 ingest
   - `before_compaction` 触发 ingest
   - `before_reset` 等待写入完成
   - `captureStrategy=last_turn` / `full_session`
   - `captureRoles=user` / `user+assistant`

#### 验收标准

1. 每个 hook 都能在 mock Omni 中看到对应 ingest 请求
2. `before_reset` 必须验证为同步等待完成
3. `before_compaction` 必须验证 event 中 `messages` 与 `sessionFile` 两条路径都能工作
4. replacement 模式下不应再依赖 overlay 脚手架证明 capture 生效

#### 收口动作

完成后，把 `openclaw-memory-slot.integration` 从“memory tool 集成测试”保留为窄测试；把 hook 行为的最终验收转移到 `replacement-hook.e2e.integration`。

---

### P0-2. Prompt 注入真实生效验证

#### Owner / ETA

1. Owner：插件测试 / OpenClaw hook 联调
2. ETA：本周

#### 现状

目前我们验证的是：

1. overlay 会发 retrieval 请求
2. replacement 会返回 `appendSystemContext`

但没有验证：

1. overlay 的 `prependContext` 是否真的进入最终 prompt
2. replacement 的 `appendSystemContext` 是否真的进入最终 prompt

#### 风险

这属于“接口返回 200，但用户功能不一定生效”的典型盲区。

#### 设计方案

优先采用“零侵入”方案，避免为了测试去修改 OpenClaw core。

路径 A：`llm_input` hook 观测

1. 写一个轻量测试辅助插件，注册 `llm_input` hook
2. OpenClaw 当前已经公开 `llm_input` 事件，能拿到：
   - `systemPrompt`
   - `prompt`
   - `historyMessages`
   见 [openclaw types.ts](/Users/zhaoxiang/工作/Openclaw/openclaw/src/plugins/types.ts)
3. 测试辅助插件把这些内容写到：
   - 内存缓冲
   - 或测试临时文件
   - 或本地 mock endpoint
4. 先做一次探针验证：
   - 直接记录 `event.systemPrompt`
   - 确认它已经包含经过 hook merge 后的最终内容，而不是 merge 前的原始 system prompt
5. 测试通过读取记录内容来断言最终 prompt

特别注意：

1. `PluginHookLlmInputEvent.systemPrompt` 是 optional，不应默认假设它总是存在
2. 我们需要验证的是：
   - overlay 的 `prependContext`
   - replacement 的 `appendSystemContext`
   最终都体现在 `systemPrompt` 里
3. 如果 probe 发现 `llm_input` 拿到的是 merge 前内容，或者 `systemPrompt` 缺失导致观测不完整，就立即切到路径 B，不在路径 A 上继续死磕

路径 B：mock model provider

1. 配置一个假的模型 provider，指向本地 HTTP server
2. 该 server 只做两件事：
   - 记录 OpenClaw 发出的请求体
   - 返回固定 assistant 响应
3. 测试通过检查 mock model server 收到的 prompt 内容来断言注入效果

推荐顺序：

1. 先做路径 A
2. 如果 `llm_input` 观测粒度不足，再补路径 B

不建议的路径：

1. 不为了这项测试直接改 OpenClaw core 的模型调用链
2. 不引入只在测试环境存在的私有 prompt dump hack

建议新增文件：

1. [test/prompt-injection.e2e.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/prompt-injection.e2e.integration.test.mjs)

#### 2026-03-21 运行时进展

1. 路径 A（`llm_input` hook 观测）已在真实 gateway E2E 中跑通
2. 已确认观测到的是 merge 之后的最终值：
   - overlay 的 recall block 出现在 `llm_input.event.prompt`
   - replacement 的 guidance 出现在 `llm_input.event.systemPrompt`
3. 当前已经有一条稳定的零侵入测试路径：
   - 使用真实 gateway
   - 使用辅助 `llm_input` recorder 插件
   - 使用本地 mock OpenAI Responses server
4. 路径 B（纯 mock model provider 观测）暂时不再是阻塞项；保留为备用方案即可
5. 为了避免 OpenClaw 构建 hash 产物和 Node compile cache 之间的旧引用问题，smoke helper 已显式关闭 compile cache；这属于测试基建稳定性修复，不改变产品逻辑

#### 验收标准

1. overlay 最终 prompt 中能找到 `<omnimemory-recall ...>` 或格式化后的 recall 内容
2. replacement 最终 prompt 中能找到 `memory_search` / `memory_get` guidance
3. 同时验证这些内容不会重复注入
4. 观测方案不要求修改 OpenClaw core
5. 路径 A 若被采用，必须先证明 `llm_input.systemPrompt` 是 merge 后的最终值

#### 收口动作

今后不再把“看到了 retrieval 请求”当作 recall 生效的充分证据；prompt 注入测试成为发布前必须通过项。

#### 2026-03-21 运行时进展

1. `llm_input` 路径已实测可用：
   - 当前 hook 看到的是 merge 之后的 `systemPrompt` / `prompt` 快照
   - 不是 `before_prompt_build` 之前的原始 prompt
2. 已新增 [test/prompt-injection.e2e.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/prompt-injection.e2e.integration.test.mjs)
3. 当前已验证两条真实 gateway E2E：
   - `overlay`：最终 prompt 中可观测到 `<omnimemory-recall ...>` 和召回内容
   - `replacement`：最终 system prompt 中可观测到 `buildMemoryPluginGuidance()` 的完整 guidance
4. 当前实现采用“路径 A 观测 + 本地 mock model endpoint 运输”的组合：
   - 观测仍然走 `llm_input`
   - 模型调用落到本地 `/v1/responses` mock server，避免依赖外部模型
5. 在这套组合下，`P0-2` 的第一版运行时证据链已经成立

---

### P0-3. suppressLocalMemoryBootstrap 运行时验证

#### Owner / ETA

1. Owner：replacement / patch 验证
2. ETA：本周，但依赖 P0-2

#### 现状

当前 [test/replacement-patch.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/replacement-patch.test.mjs) 只验证：

1. patch 能改源码
2. patch 是幂等的

没有验证 replacement 模式运行时是否真的跳过了 `MEMORY.md` / `memory/*.md`。

#### 风险

如果 patch 只是在源码层面成功，但运行时仍把本地 memory bootstrap 混进去，那么 replacement 的“语义纯净”是假的。

#### 设计方案

做一个临时 workspace 的运行时测试：

1. 创建临时 workspace
2. 写入：
   - `MEMORY.md`
   - 一个唯一 marker
3. 启动 replacement 模式 gateway
4. 触发一次真实 run
5. 通过 P0-2 的最终 prompt 观测能力断言：
   - 本地 bootstrap marker 没进入 prompt
   - memory tool guidance 仍正常存在

补充校正：

1. 当前 OpenClaw 默认 runtime bootstrap 基线是根目录 `MEMORY.md`
2. `memory/*.md` 并不会在默认路径下自动进入最终 prompt
3. 因此这项 P0 先验证“默认真实路径”：
   - `MEMORY.md` 在 suppress 开启时被移除
   - `MEMORY.md` 在 suppress 关闭时重新出现
4. `memory/*.md` 的 suppress 行为保留为后续补充场景，只在明确存在 hook/extra bootstrap 注入时再单独验证

补充说明：

1. 这项默认依赖 P0-2 完成后的 prompt 观测能力
2. 如果 P0-2 尚未完成，可先走一个临时弱验证路径：
   - 检查 `suppressLocalMemoryBootstrapFiles(...)` 触发的 `warn?.(...)` 输出
   - 只把它当阶段性信号，不当最终验收

建议新增文件：

1. [test/replacement-bootstrap.runtime.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/replacement-bootstrap.runtime.integration.test.mjs)

#### 验收标准

1. `MEMORY.md` 的 marker 在 `suppressLocalMemoryBootstrap=true` 时不进入最终 prompt
2. `MEMORY.md` 的 marker 在 `suppressLocalMemoryBootstrap=false` 时重新进入最终 prompt
3. replacement guidance 在 suppress 开关两种情况下都仍然存在
4. 至少有一条运行时信号能证明 suppress 确实发生过
   - 例如 bootstrap suppress warning

#### 2026-03-21 运行时进展

1. 已新增 [test/replacement-bootstrap.runtime.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/replacement-bootstrap.runtime.integration.test.mjs)
2. 该测试会：
   - 真实 apply replacement patch
   - 强制重建 OpenClaw dist
   - 在 `suppressLocalMemoryBootstrap=true/false` 两种配置下分别跑真实 gateway
   - 通过 `llm_input` 观测最终 prompt
3. 当前已验证：
   - `MEMORY.md` 在 suppress 开启时不会进入最终 prompt
   - `MEMORY.md` 在 suppress 关闭时会重新进入最终 prompt
4. 这也进一步确认了一个产品事实：
   - 当前 OpenClaw 默认 bootstrap 基线是根目录 `MEMORY.md`
   - `memory/*.md` 不是默认 runtime bootstrap 的一部分
5. 本地 OpenClaw 在测试结束后会自动 revert 到未 patch 状态，不会把 replacement patch 留在上游仓库里

#### 收口动作

这项完成前，不把 replacement 对外描述成“已完全替代本地 markdown memory”。

---

### P0-4. 真实 OmniMemory live smoke

#### Owner / ETA

1. Owner：联调 / 发布验证
2. ETA：本周固化脚本，上线前必跑

#### 现状

虽然我们已经做过手工 live 验证，但现在缺少稳定、可复用的上线脚本入口。

#### 设计方案

固化为可选脚本：

1. `npm run test:live:overlay`
2. `npm run test:live:replacement`
3. 环境变量要求：
   - `OMNI_MEMORY_API_KEY`
   - 可选 `OPENROUTER_API_KEY`
4. 默认只跑 smoke：
   - 一次 ingest
   - 一次 retrieval
   - 一次真实 gateway 联动
5. 增加 live 环境失败判定：
   - ingest 后允许 retrieval 最多等待 30s 再查询
   - 单次 live smoke 总时长超过 60s 判定为失败
6. 增加最小重试策略：
   - retrieval 最多重试 3 次
   - 仅用于吸收索引延迟，不用于掩盖格式错误或鉴权错误

可复用已有脚本：

1. [scripts/run-service-retrieval-check.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/scripts/run-service-retrieval-check.mjs)
2. [scripts/run-service-retrieval-benchmark.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/scripts/run-service-retrieval-benchmark.mjs)

#### 验收标准

1. 在真实 Omni 后端上成功完成 `/retrieval` 与 `/ingest`
2. replacement 模式真实通过 `memory_search/memory_get`
3. overlay 模式真实通过 `before_prompt_build + capture`
4. ingest 成功但 retrieval 在 30s 内仍查不到刚写入数据，判定为失败
5. 总时长超过 60s 判定为失败

#### 2026-03-21 运行时进展

1. 已新增 live smoke 脚本与入口：
   - [scripts/run-live-smoke.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/scripts/run-live-smoke.mjs)
   - [package.json](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/package.json)
2. `overlay` 标准 smoke 已真实通过：
   - 本地真实 OpenClaw gateway + 本地插件 + 真实 Omni 云后端
   - 结果文件：[live-smoke-overlay.json](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/outputs/live-smoke-overlay.json)
   - 当前结果：`ok=true`、约 `11.1s` 完成、真实观测到最终 prompt 中的 recall block
3. `replacement` 标准 smoke 当前未达标：
   - 结果文件：[live-smoke-replacement.json](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/outputs/live-smoke-replacement.json)
   - 当前结果：`ingestVerified=true`，但在 `30s` retrieval 窗口 / `60s` 总时长门槛下仍无法稳定查回当次 marker
4. 已做一轮长窗口诊断确认失败性质不是脚本字段错配：
   - 结果文件：[live-smoke-replacement-long.json](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/outputs/live-smoke-replacement-long.json)
   - 当前结果：在放宽到 `120s` retrieval 窗口后，replacement 最终成功，单次成功耗时约 `73.6s`
5. 当前更准确的结论是：
   - replacement 的真实 `gateway -> capture -> ingest -> memory_search/memory_get` 链路已经打通
   - 但真实后端对“新写入数据的可检索可见性”还达不到当前文档定义的 `30s/60s` 上线门槛
6. 因此 P0-4 当前状态应标记为：
   - `overlay: pass`
   - `replacement: functional pass, SLA fail`

#### 收口动作

把 live smoke 变成“上线前人工 checklist 必跑项”，不再只依赖 mock。

---

## 3. P1：上线前强烈建议补齐

### P1-1. before_compaction event 结构验证

#### Owner / ETA

1. Owner：hook E2E
2. ETA：上线前

#### 现状

插件同时支持：

1. `event.messages`
2. `sessionFile fallback`

但当前 E2E 没有专门证明 OpenClaw 在 compaction 场景下给到的 event 结构符合插件预期。

同时需要澄清一个实现事实：

1. 按当前 OpenClaw runtime，`before_compaction` 的稳定主路径更偏向 `sessionFile`
2. `event.messages` 在类型层是允许的，但不是当前 compaction runtime 最可依赖的数据来源
3. 因此这项收口应优先验证 `sessionFile fallback`，再补 `inline messages` 的健壮性 / 前向兼容

#### 设计方案

分两层补：

1. 插件侧集成验证：
   - replacement `before_compaction` 在 `inline messages` 存在时优先吃 `event.messages`
   - replacement `before_compaction` 在只有 `sessionFile` 时能正确 fallback 并 capture
2. OpenClaw 侧事实对齐：
   - 明确引用 OpenClaw 自身 compaction hook wiring 测试，说明当前 runtime 主路径是 `sessionFile`
   - 后续若要继续加真实 gateway auto-compaction E2E，重点验证 `sessionFile` 路径，不把 `messages` 当默认前提

#### 验收标准

1. `inline messages` 存在时，插件优先 capture `event.messages`
2. `sessionFile`-only 的 compaction event 能正确 capture transcript
3. 当前文档口径明确写出：
   - OpenClaw 当前 compaction runtime 主路径依赖 `sessionFile`
   - `inline messages` 属于插件兼容能力，不是当前 gateway 的默认承诺

#### 2026-03-21 运行时进展

1. 已新增 [test/replacement-before-compaction.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/replacement-before-compaction.integration.test.mjs)
2. 当前已验证两条 replacement 插件侧路径：
   - `before_compaction` 有 `event.messages` 时，优先 capture inline messages
   - `before_compaction` 只有 `sessionFile` 时，能正确 fallback 并 capture transcript
3. 另外已核对 OpenClaw 上游实现：
   - `before_compaction` 类型允许 `messages` 与 `sessionFile`
   - 但当前 runtime 更稳定依赖 `sessionFile`
4. 因此这项当前状态可以记为：
   - `plugin behavior: pass`
   - `runtime fact clarified: sessionFile-first`
   - `full auto-compaction gateway E2E: optional follow-up`

---

### P1-2. 超时 E2E

#### Owner / ETA

1. Owner：mock server / failure handling
2. ETA：上线前

#### 现状

现在只测了 HTTP 500，没有测 timeout。

#### 风险

云后端慢响应比 500 更常见。

#### 设计方案

在 [scripts/lib/mock-omni-server.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/scripts/lib/mock-omni-server.mjs) 加延迟 handler，模拟：

1. retrieval 超时
2. ingest 超时

分别验证：

1. recall `fail-open`
2. capture `best-effort`
3. 日志里有超时告警，但不泄露用户原文

#### 验收标准

1. retrieval timeout 不阻断 agent 继续跑
2. ingest timeout 不导致后续 hook 状态损坏
3. 失败后第二次请求仍能恢复

#### 2026-03-21 运行时进展

1. 已新增 [test/timeout.e2e.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/timeout.e2e.integration.test.mjs)
2. 当前已验证两条真实 timeout 行为：
   - `overlay` retrieval timeout -> fail-open，当前 hook run 仍完成且后续 capture 正常发生
   - `replacement` ingest timeout -> best-effort，后续 hook run 与 `memory_search` 工具调用仍能恢复
3. 这项当前状态可以记为：
   - `overlay timeout path: pass`
   - `replacement timeout path: pass`

---

### P1-3. fingerprint 去重边界

#### Owner / ETA

1. Owner：runtime writeback
2. ETA：上线前

#### 现状

overlay 侧测过部分去重路径，但 replacement 没有专门覆盖。

#### 设计方案

新增 replacement 边界测试：

1. `capture -> same messages -> capture` 第二次跳过
2. `capture -> messages + 1 line -> capture` 第二次不跳过
3. `before_reset(wait=true)` 下去重仍成立

#### 验收标准

重复消息不重复写入，增量消息不被误跳过。

#### 2026-03-21 运行时进展

1. 已新增 [test/replacement-dedupe.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/replacement-dedupe.integration.test.mjs)
2. 当前已验证两条 replacement 去重边界：
   - `capture -> same transcript -> capture`：第二次不会重复写入
   - `capture -> append one more line -> capture`：第二次会重新写入，且新行进入 payload
3. 这批用例当前走的是 replacement 的真实主路径：
   - `before_compaction`
   - `sessionFile fallback`
4. 这项当前状态可以记为：
   - `replacement dedupe boundary: pass`

---

### P1-4. 并发写入安全

#### Owner / ETA

1. Owner：runtime writeback
2. ETA：上线前

#### 现状

[src/runtime/omni-client.js](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/src/runtime/omni-client.js) 里的 `sessionWriteState` 是进程级 `Map`，并发写入同一 scope 时存在 race 可能。

#### 设计方案

做一个受控并发压力测试：

1. 两个 session 同时写入同一 scope
2. 两个 run 同时写入同一 session
3. 记录 cursor / fingerprint 的最终状态

建议新增：

1. [test/writeback-concurrency.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/writeback-concurrency.integration.test.mjs)

#### 验收标准

1. `N` 次受控并发写入后，server 侧实际收到的 non-duplicate turns 数等于预期 turns 总数
2. 任一 ingest 请求的 `cursor.base_turn_id` 不与另一个并发请求生成的 turn range 冲突
3. 最终 persistent state 中的 fingerprint 与最后一批已提交消息一致
4. 并发结束后再次执行一次串行 capture，不应产生额外重复写入

#### 收口说明

这项完成前，文档里要继续保留“目前去重为 fingerprint 级，不是 exactly-once”的表述。

#### 2026-03-21 运行时进展

1. 已新增 [test/writeback-concurrency.integration.test.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/test/writeback-concurrency.integration.test.mjs)
2. 已在 [src/runtime/omni-client.js](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/src/runtime/omni-client.js) 为同一 ingest scope 增加进程内串行写锁
3. 当前已验证两条并发边界：
   - 同 scope + 不同 payload：第二次会基于更新后的 `cursor.base_turn_id` 顺序续写，不再撞 turn range
   - 同 scope + 相同 payload：并发情况下只会真正提交一次，另一条会在锁内命中 `duplicate`
4. 这项当前状态可以记为：
   - `controlled same-scope concurrency: pass`
   - `cross-process exactly-once: still not guaranteed`

---

## 4. P2：后续治理

### P2-1. 多 plugin 共存直接禁止

#### Owner / ETA

1. Owner：产品约束 / 管理脚本 / doctor
2. ETA：后续治理，但在正式对外前完成最少 fail-fast

#### 产品结论

不推荐共存不是建议，而是产品约束：

1. 不能同时启用 `omnimemory-overlay`
2. 不能同时启用 `omnimemory-memory`

#### 原因

如果两者共存，会产生：

1. 重复 prompt 注入
2. recall 语义混乱
3. capture 路径重复
4. 排障成本大幅上升

#### 设计方案

做成三级防护：

1. 配置层防护
   - `manage` 脚本安装一种模式时，自动禁用另一种模式
2. `doctor` 防护
   - 检测到两者同时启用时直接报红
3. 运行时防护
   - 任一插件启动时发现另一种模式也启用，直接报错并拒绝启动

#### 验收标准

1. 双启用场景无法进入“看起来能跑”的灰色状态
2. 错误信息明确告诉用户只能二选一

#### 收口动作

文档从“不推荐”改成“禁止同时启用”。

---

### P2-2. Patch 兼容治理

#### Owner / ETA

1. Owner：replacement / patch 维护
2. ETA：第一版门禁本周，矩阵治理后续持续推进

#### 现状

当前 [src/replacement/patch-core.js](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/src/replacement/patch-core.js) 依赖源码锚点替换，已经是幂等的，但仍依赖上游结构稳定。

#### 设计方案

短期：

1. `patch:status` 进入发布检查
2. 在 CI 里验证 anchor 是否匹配
3. README 明确支持的 OpenClaw 版本范围

中期：

1. 增加至少一个 canary 版本探测
2. 输出更清楚的 incompatibility report

长期：

1. 推动 OpenClaw core 提供官方 memory provider abstraction

#### 收口说明

这项在当前阶段不是发布阻断项，但它是 replacement 长期可靠性的最大结构性技术债。

---

## 5. 实施顺序

### 第一批：本周收口

1. 并行启动：
   - `Replacement` 版本对齐与版本门禁
   - `replacement-hook.e2e.integration`
2. `replacement-hook.e2e.integration` 优先拿到第一批运行时证据
3. 基于真实 hook 证据推进 `prompt-injection.e2e.integration`
4. 完成 `replacement-bootstrap.runtime.integration`
5. 固化 `test:live:*` 脚本

依赖说明：

1. `P0-0` 与 `P0-1` 无硬依赖，可以并行推进
2. `P0-1` 产出的运行时证据，会直接反哺 `P0-0` 支持矩阵内容
3. `prompt-injection.e2e.integration` 依赖 `replacement-hook.e2e.integration` 提供的 gateway / smoke 脚手架基础
4. `replacement-bootstrap.runtime.integration` 默认被 `prompt-injection.e2e.integration` 阻塞
5. 如果 `prompt-injection` 尚未完成，只允许先做日志级弱验证，不算最终收口

更精确的依赖图：

1. `P0-0 (版本门禁)` 与 `P0-1 (hook E2E)` 可并行
2. `P0-2 (prompt 注入验证)` 依赖 `P0-1` 的 gateway 测试基础
3. `P0-3 (bootstrap suppression runtime)` 硬依赖 `P0-2` 的 prompt 观测能力
4. `P0-4 (live smoke)` 无硬依赖，但建议排在 `P0-1/P0-2` 之后

### 第二批：上线前补强

1. `before_compaction` event 结构测试
2. timeout E2E
3. fingerprint 去重边界
4. 并发写入测试
5. rollback 验证
6. 错误体验审查

### 第三批：后续治理

1. 禁止多 plugin 共存
2. patch 兼容探测
3. OpenClaw core 官方抽象推动

---

## 6. 上线前检查清单

### 必须通过

1. `npm test` 全绿
2. `npm run test:integration` 全绿
3. `npm run doctor` 无红色
4. overlay 真实 smoke 通过
5. replacement 真实 smoke 通过
6. replacement 版本门禁通过
7. replacement hook E2E 通过
8. prompt 注入验证通过
9. bootstrap suppression 运行时验证通过
10. `manage:rollback` 验证通过

自动化建议：

1. 把可自动检测项尽量收进：
   - `npm run doctor`
   - 或 `npm run preflight`
2. 自动化范围至少覆盖：
   - 测试全绿
   - patch status / 版本门禁
   - rollback 基础校验
   - live smoke 脚本入口存在性与参数校验

### 必须人工确认

1. replacement 模式下 `memory_search` / `memory_get` 可用
2. replacement 模式下 `MEMORY.md` 不再进入最终 prompt
3. replacement 当前 OpenClaw 版本在支持矩阵中
4. overlay 模式下 recall 结果确实出现在最终 prompt
5. 慢网络下 timeout/fail-open 行为可接受
6. `patch:status` 在目标 OpenClaw 版本上为绿色

### rollback 验证要求

1. 执行 `node scripts/omnimemory-manage.mjs rollback` 后：
   - `plugins.slots.memory` 恢复为默认值
   - replacement 插件被禁用
   - patch 被 revert
2. replacement 回滚后：
   - 本地 `MEMORY.md` bootstrap 恢复生效
   - gateway 可以正常重启

### 错误体验审查

至少审查以下阻断错误：

1. `apiKey` 缺失或错误
2. OpenClaw 版本不受支持
3. `patch:apply` 失败
4. live smoke 鉴权失败

每个错误都应包含：

1. 错误原因
2. 影响范围
3. 下一步建议动作

说明：

1. 这项原本的短板是 `requireApiKey()` 与 patch/manage 报错都偏技术化
2. 当前重点是把高频阻断错误先收口成“原因 + 影响 + 下一步动作”，再继续润色整体 CLI 体验

#### 2026-03-21 运行时进展

1. [src/runtime/config.js](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/src/runtime/config.js) 的 `requireApiKey()` 已改成可执行提示：
   - 直接告诉用户可以在 plugin config 中设置 `apiKey`
   - 或使用 `apiKey: "${OMNI_MEMORY_API_KEY}"` + 导出环境变量
2. [scripts/run-live-smoke.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/scripts/run-live-smoke.mjs) 的 API key 缺失报错已改成：
   - 明确缺哪个环境变量
   - 明确可用 `--api-key-env <NAME>` 切换变量名
   - 默认不再额外打印 Node stack
3. [scripts/openclaw-replacement-patch.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/scripts/openclaw-replacement-patch.mjs) 已为这些高频阻断错误补上 `reason / impact / next step`：
   - patch anchor changed upstream
   - missing target file
   - no patch state found during revert
4. [scripts/omnimemory-manage.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/scripts/omnimemory-manage.mjs) 已去掉默认 stack dump，避免用户先看到一屏技术栈
5. [scripts/replacement-compatibility.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/scripts/replacement-compatibility.mjs) 和 [scripts/doctor.mjs](/Users/zhaoxiang/工作/Openclaw/OmniMem-OpenClaw-Plugin/scripts/doctor.mjs) 当前已经能给出结构化版本门禁信息
6. 这项当前状态可以记为：
   - `critical blocking errors: improved`
   - `doctor/manage overall UX: materially better, can still be polished further`

---

## 7. 最终收口判断

### 可以对外试点的条件

满足以下条件后，可以把当前版本定义为“可试点的 Beta”：

1. overlay/replacement 两种模式都有完整运行时 E2E
2. prompt 注入效果已经被最终 prompt 级别证明
3. replacement 已被证明会抑制本地 bootstrap memory
4. replacement 已具备明确版本门禁，只对受支持的 OpenClaw 版本放行
5. 至少有一条稳定的真实 Omni live smoke

### 还不能对外讲满的点

在以下问题没有补齐前，不建议把 replacement 描述成“生产级完美替代”：

1. patch 仍依赖上游源码锚点
2. 去重仍不是 exactly-once
3. 并发写入已有进程内串行锁保护，但跨进程 exactly-once 仍未保证
4. 后端 retrieval ranking 质量仍存在题型波动
