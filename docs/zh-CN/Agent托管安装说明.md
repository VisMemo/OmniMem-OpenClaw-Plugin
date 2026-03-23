# Agent 托管安装说明

这份文档的目标不是教用户手工折腾配置，而是让用户只给 Agent 一段指令，剩下由 Agent 自动完成。

## 当前产品结论

目前我们已经具备两种可交付形态：

1. 一份给终端用户直接复制粘贴的安装提示词
2. 一个给 Agent 使用的 `omnimemory-installer` skill
3. 一个可分发的技能包：`dist/omnimemory-installer.skill`

当前最推荐的产品入口是：

1. 默认先走 `Overlay`
2. 高级用户再走 `Replacement`
3. `Replacement + patch` 只在用户明确接受“替换底座 + 轻量 core surgery”时启用

## 现在已经能自动化到哪一步

Agent 现在可以自动完成：

1. 用 `openclaw plugins install <package-dir>` 安装标准本地插件包
2. 写入 `plugins.entries.<id>.enabled`
3. 写入 OmniMemory 配置
4. `Replacement` 模式下切换 `plugins.slots.memory`
5. 可选调用 replacement patch
6. 运行 `openclaw config validate`
7. 尝试 `openclaw gateway restart`
8. 运行本地 smoke 或状态检查
9. 输出安装报告

用户仍需提供的最少信息：

1. 选择 `overlay` 或 `replacement`
2. OpenClaw 仓库路径或已安装 CLI
3. OmniMemory 插件仓库路径
4. Omni API key 或环境变量名

## 给用户的一段复制粘贴提示词

### Overlay

```text
请帮我把 OmniMemory 以 Overlay 模式接入当前 OpenClaw。

要求你全权执行，不要只给我方案：
1. 使用 OmniMem-OpenClaw-Plugin/skills/omnimemory-installer/scripts/install_omnimemory.mjs
2. mode=overlay
3. OpenClaw 路径是：/abs/path/to/openclaw
4. OmniMemory 插件路径是：/abs/path/to/OmniMem-OpenClaw-Plugin
5. API key 环境变量名是：OMNI_MEMORY_API_KEY
6. 执行后做 config validate、plugins doctor、gateway restart
7. 最后告诉我改了什么、是否已经生效、如果没生效卡在哪一步
```

### Replacement

```text
请帮我把 OmniMemory 以 Replacement 模式接入当前 OpenClaw，并替换 memory 底座。

要求你全权执行，不要只给我方案：
1. 使用 OmniMem-OpenClaw-Plugin/skills/omnimemory-installer/scripts/install_omnimemory.mjs
2. mode=replacement
3. OpenClaw 路径是：/abs/path/to/openclaw
4. OmniMemory 插件路径是：/abs/path/to/OmniMem-OpenClaw-Plugin
5. API key 环境变量名是：OMNI_MEMORY_API_KEY
6. 允许 apply replacement patch
7. 执行后做 config validate、plugins doctor、gateway restart
8. 最后告诉我改了什么、是否已经生效、当前 memory slot 是不是 OmniMemory
```

## 给 Agent 的推荐执行顺序

1. 优先使用 `node <openclawRoot>/dist/index.js`
2. 用 `scripts/omnimemory-manage.mjs install --mode ...` 统一走安装链
3. 仅在 replacement 模式下考虑 patch
4. validate 成功后再 restart 或做 smoke
5. 失败时必须明确报错，不得假装安装完成

## 当前仍然不是“完全无感”的点

1. 现在已经是标准本地可安装插件包，但还不是 npm 已发布包
2. 也就是说，本地 checkout 路径安装已经成立，远程 npm spec 安装还没走完最后一公里
3. 如果未来发布为 npm 插件包，用户输入还能继续缩短

## 下一阶段最值得做的产品增强

1. 把两个插件形态发布成 npm 包
2. 把 `omnimemory-installer` skill 打包成 `.skill` 分发件
3. 持续增强“模式切换/回滚”脚本
4. 增加真实环境安装后的 smoke 验证脚本
