# 本地智能工作台恢复、重构与长续航 Agent 设计

## 决策摘要

- 产品形态：单用户、本地优先的“静谧任务台”，以项目、任务、对话和产物为主线。
- 前端：React + Vite + TypeScript。桌面为 240px 导航、中央任务时间线、300px 上下文检查器；移动端降级为抽屉与单栏。
- 后端：固定 Node.js 24.18 LTS，使用内置 `node:sqlite`；HTTP、存储、调度、上下文、工具、安全分层。
- 持久化：SQLite WAL 保存结构化状态，大 payload 以 SHA-256 寻址并加密落盘。
- 长任务：默认 72 小时、288 次模型调用、1200 万输入 token、200 万输出 token、可估价时 25 美元；预算可调整，关闭硬上限必须确认。
- 开发隔离：每个长开发任务使用 `.worktrees/<run-id>` 和 `codex/run-<short-id>` 分支；Agent 不得自行合并、推送或删除分支。
- 桌面生命周期：关闭主窗口进入托盘；开机自启可选且默认关闭；异常退出后从事务、租约和检查点恢复。

## UI 设计系统

主导航固定为“今天、项目、任务、知识库、自动化、设置”。旧平级视图按工作流归类：Data、Canvas、Code、Terminal、Git 进入项目工作区；Web、Research、Memory 进入知识区；Engineer、Dev、Patch Queue、Agents 进入任务运行。

中央时间线呈现消息、计划步骤、工具请求/结果、引用、审批、Diff、测试、检查点、错误、提交和产物，不展示隐藏思维。右侧检查器呈现 VISTA block、token 压力、预算、权限和待审批项。

设计令牌：背景 `#F7F6F2`、导航 `#F1EFE9`、表面 `#FFFFFF`、正文 `#1F231F`、强调 `#2F7D67`、风险琥珀色；系统中文字体、6/8px 圆角、4–32px 间距、克制阴影。支持暗色、键盘导航、可见焦点、ARIA 和 `prefers-reduced-motion`。

## VISTA clean-room 设计

依据 [论文 v5](https://arxiv.org/html/2606.30005v5) 的公开协议自行实现，不复制无仓库级许可证的 VISTA 源码；详细边界见 [来源与 clean-room 说明](../../PROVENANCE.md)。每个运行拥有独立 Context Workspace；目标、验收标准和约束为 pinned blocks。其他块包含稳定 ID、类型、父级、层级、状态、token 估算、摘要、来源、payload 引用、校验和、完整性与访问时间。

Agent 可自主 archive/recover，用户可 pin/unpin/精确恢复；永久删除必须确认。默认压力线为 80% 提示、92% 管理模式、98% hard preflight；单结果达到 12k token 或单轮累计 50k token 时无损外置。摘要只用于导航，原始 payload 保持可恢复。

## 长续航与安全

运行状态为 `queued | running | sleeping | waiting_approval | paused | reconciling | blocked | completed | failed | canceled`。调度器默认单并发，30 秒心跳、90 秒租约；错误按 1/5/15/60 分钟退避。连续 8 次模型调用无可验证进展或同一失败自动修复 3 次仍失败时暂停。

外部动作先写 effect intent，完成后写结果和校验和；崩溃后无法证明副作用结果时进入 reconciling，不盲目重放。Run Grant 固定路径、命令、网络域、模型、期限和预算；越界和高风险动作暂停审批。

## 验收门禁

- API、SQLite、SSE、上下文、授权、迁移、worktree、故障注入和安全测试通过。
- 1440×920、980px、390×844 UI 验证通过，无根级横向溢出和浏览器错误。
- 使用假时钟与 Mock Provider 完成 72 小时加速模拟。
- 发布候选完成真实墙钟 72 小时无费用 Mock soak 前，不声明“三天稳定已验证”。

## 视觉基线说明

内置图片服务连续两次网络失败后，用户明确选择文字线框并批准“静谧任务台”作为生产设计基线。后续若补充概念图，只能表达本文已冻结的结构与令牌，不能反向改变产品设计。
