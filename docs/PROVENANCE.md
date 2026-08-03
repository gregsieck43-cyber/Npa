# 来源与 clean-room 说明

本项目的 Context Workspace 只依据公开论文描述重新设计接口、数据模型和测试，没有复制 VISTA 仓库源码、文件结构或实现细节。

参考资料：

- VISTA 论文（CC BY 4.0）：<https://arxiv.org/abs/2606.30005>
- 项目页：<https://vista-agent.github.io/>
- 上游来源说明：<https://github.com/binyxu/VISTA/blob/main/docs/PROVENANCE.md>

采用的高层思想包括类型化上下文块、上下文状态可视化、归档与恢复、压力阈值和恢复前预算检查。本项目自己的实现使用 SQLite 元数据、SHA-256 内容寻址、AES-256-GCM payload 存储、审计事件和本地权限模型。

VISTA 代码仓库没有适用于整个仓库的统一许可证，因此本项目不引入或改写该仓库源码。若未来需要引入任何上游文件，必须先逐文件确认授权，并在这里记录来源、许可证和修改。
