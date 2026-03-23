# OmniMem OpenClaw 插件

将 OmniMemory 以两种产品模式接入 OpenClaw：`Overlay` 和 `Replacement`。

- 英文入口文档：[README.md](./README.md)
- 中文文档索引：[docs/zh-CN/README.md](./docs/zh-CN/README.md)
- 中文详细使用说明：[docs/zh-CN/使用说明.md](./docs/zh-CN/使用说明.md)
- 当前实现原则：[docs/zh-CN/实现原则.md](./docs/zh-CN/实现原则.md)
- 当前限制与后续工作：[docs/zh-CN/当前限制与后续工作.md](./docs/zh-CN/当前限制与后续工作.md)

## 仓库定位

这个仓库面向两类场景：

- `Overlay`
  - 非破坏性外挂增强
  - 通过 OpenClaw hook 做 recall / capture
  - 不接管 `plugins.slots.memory`
  - 当前默认推荐
- `Replacement`
  - 通过 `kind: "memory"` 接管 `memory_search / memory_get`
  - 可选叠加 patch，抑制本地 `MEMORY.md` bootstrap
  - 面向高级用户，必须关注 OpenClaw 版本适配

## 快速开始

1. 设置 API Key

```bash
export OMNI_MEMORY_API_KEY="qbk_xxx"
```

2. 推荐先安装 `Overlay`

```bash
git clone https://github.com/VisMemo/OmniMem-OpenClaw-Plugin.git
cd OmniMem-OpenClaw-Plugin
node scripts/omnimemory-manage.mjs install --mode overlay
```

3. 执行诊断

```bash
npm run doctor
```

如需切换到 `Replacement`：

```bash
node scripts/omnimemory-manage.mjs switch --mode replacement --apply-patch
```

## 当前建议

- 默认推荐 `Overlay`
- `Replacement` 作为高级替换路径
- patch 只是 `Replacement` 的增强层，不是第三种模式
- 对严格版本一致性的要求，应优先查看 [docs/en/replacement-compatibility.md](./docs/en/replacement-compatibility.md)

## 主要文档

- [中文文档索引](./docs/zh-CN/README.md)
- [使用说明](./docs/zh-CN/使用说明.md)
- [实现原则](./docs/zh-CN/实现原则.md)
- [OpenClaw 接口映射](./docs/zh-CN/OpenClaw-接口映射.md)
- [当前限制与后续工作](./docs/zh-CN/当前限制与后续工作.md)
- [测试与上线收口 TODO](./docs/zh-CN/测试与上线收口TODO.md)
- [Agent 托管安装说明](./docs/zh-CN/Agent托管安装说明.md)

## 常用命令

```bash
npm run packages:sync
npm test
npm run test:integration
npm run doctor
npm run smoke:standard-install
npm run patch:status
```
