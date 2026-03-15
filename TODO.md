# TODO

## P0: 当前最重要

- [ ] 和 OpenClaw 社区继续适配最新插件接口与加载约定，重点参考 memos 插件的 lifecycle 组织方式
- [ ] 与 Omni 侧确认 `run_id` / session 检索语义，解决真实 smoke 中暴露出的跨 session 低位召回串扰
- [ ] 完成真实环境接入测试，包括真实 OpenClaw 工作区、真实 restart、真实用户路径 smoke
- [ ] 把 README 和接入说明继续收敛成面向外部用户的一套最短可执行指引

## P1: 发布与文档

- [ ] 文档英文化翻译：README、使用说明、限制说明、Agent 托管安装说明
- [ ] 把 `omnimemory-overlay` / `omnimemory-memory` 发布成 npm 包
- [ ] 增加 release 流程、版本策略和 changelog 维护方式
- [ ] 完善对外接入文档，覆盖本地路径安装、Agent 托管安装、模式切换、回滚

## P2: 产品化增强

- [ ] 提升写回去重为 cursor-based exactly-once 语义
- [ ] 增加本地 markdown memory 导入 / 同步命令
- [ ] 增加 richer evidence formatting 和更稳定的 `memory_get` 展示
- [ ] 增强 smoke / doctor 输出，让失败原因和生效状态更清晰
- [ ] 评估将 patch 兼容报告做成面向 OpenClaw 版本的自动诊断矩阵
