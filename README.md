# NPN-Gamma Code

Windows 桌面 Agent，支持 Chat 对话、Cowork 任务和 Code 工作区。**公开源码 0.0.1** 对应 Windows 桌面版 **NPN-Gamma 0.7.6**。桌面、CLI 与 MCP 连接同一台机器上的后台。首次启动使用本地 Mock，可离线验证消息、审批和历史恢复。

## 本版使用方式

- 新会话输入框上方可以选择项目。项目名旁的加号打开编辑器，登记多个文件夹时可指定主要目录，并为新会话选择工作目录。
- Chat 用于日常对话。Cowork 支持添加 UTF-8 文本、Word、Excel 或 PowerPoint 材料，完成回复后可以生成和打开 DOCX、XLSX、PPTX 或 PDF 文件。生成的文件与当前会话和回复关联。Code 提供开发工作区与 IDE。输入框下方的加号提供附件与适用的计划选项。
- 在 **设置 → 模型 → 添加模型** 填入 HTTPS Base URL、模型 ID 和 API 格式，按需填写本次会话密钥和一天内允许的请求数。点击“刷新模型列表”读取供应商目录。保存前的桌面确认会列出模型、端点及调用额度。长期使用外部密钥文件可沿用原生配置导入。
- 可直接选择 Anthropic Messages、Chat Completions 或 Responses。自定义选项支持相对于 Base URL 的端点路径、基础协议、凭据头和字段映射。输入映射以标准请求的字段名为键、服务商的点分路径为值。输出和流映射可读取正文、结束原因、用量与标准工具调用结构。流映射中的 `done` 指向布尔完成标记。
- 模型目录随版本内置，精确模型标识、已知供应商及在线目录共同决定建议值。模型服务未公布的字段可手动补充。当前单次请求输出上限为 131072 tokens，实际调用还受所选模型和上下文限制。目录数据来自 [models.dev](https://models.dev)，许可见 [MIT 许可](licenses/models.dev-MIT.txt)。

在独立 IDE 中，输入栏上方可添加编辑器选区，下方可选择模型并发送。「＋」收纳工具审批开关、请求与用量、任务轨迹、终端和桌面入口。

## 从源码启动

需要 Windows x64、Git、官方 Windows x64 Node.js **24.16.0**（含 npm），以及 Windows .NET Framework 4.x 的 64 位 C# 编译器。初次安装需联网下载 npm 依赖及 Electron **44.6.0**。在普通用户可写的本地目录中打开 PowerShell，执行以下命令。

```powershell
git clone https://github.com/gregsieck43-cyber/Npa.git
cd Npa
.\scripts\setup.ps1
npm.cmd start
```

安装脚本用锁文件安装依赖、准备项目内 Node 和 Electron、编译原生资源守卫、后台、桌面前端及 IDE 扩展。以后在同一目录运行 `npm.cmd start` 即可。应用使用可写的 `data/` 保存本机配置和历史。先在 Chat 新建对话并发送一条消息，确认收到 Mock 回复。启动桌面后，可在同一目录另开终端运行 `npm.cmd run cli -- list` 核对后台连接。MCP 客户端使用项目 Node 启动 `build/src/entry.js --mcp --data-dir <同一数据目录的绝对路径>`，通信使用标准输入输出。

## 可选的原生配置文件导入

1. 准备支持 Chat Completions 的 HTTPS 端点、模型 ID 和自己的密钥。将单条密钥保存到与项目同一安装卷、仓库外的本地普通文件。
2. 将 `examples/native-provider-import.template.json` 复制到同卷的私人目录。替换 `baseUrl`、`model` 与 `credentialFile`，填写显示名。端点使用服务商的 API 基址，凭据字段填写文件绝对路径。JSON 使用无 BOM 的 UTF-8 编码。
3. 在桌面菜单 **NPN-Gamma → 导入模型配置…** 选择文件，核对服务商、模型、请求上限和授权天数后确认。重新打开 **设置 → 模型** 查看或选择配置。导入的模型配置会授权 live 请求，导入操作本身不发起模型调用。
4. 显式发送一条消息验证回复。请求计入自己的服务商额度。模板默认上限为 1 次、有效期为 1 天。聊天、请求记录和工作区内容保存在本机；发送给服务商的内容受会话和工具设置影响。

`credentialFile` 须指向 1–8192 字节的普通文件，路径不得经过符号链接或 junction。Base URL 不能带认证信息、查询串或片段。分享问题报告前检查附件内容。详见 [安全报告](SECURITY.md)。

## 可选 IDE 与本地工具

桌面 Chat、Cowork 和 Code 基础工作区可直接使用。打开独立 IDE 还需 Python 3.11+。完成基础安装后从仓库根执行：

```powershell
python -I -B scripts/acquire-ide-host.py --root (Get-Location).Path
npm.cmd run brand:ide
```

下载脚本校验固定版本 VSCodium **1.135.06055** 的上游 SHA-256，准备项目内的便携宿主。打开一个工作区后使用 **Code → IDE ↗**，也可从根目录执行 `.\NPN-IDE.cmd`。REA 6.4.0 为可选集成，初装未启用。CLI、MCP 和后端配置使用同一数据目录。

## 0.0.1 验证记录

Windows 源码检查与独立克隆安装通过。发布冒烟 42/42，前端回归 182/182。对应的桌面 0.7.6 实包验证了多目录项目、办公附件、四种导出格式、冷启动恢复，以及本地 HTTPS 服务的模型发现和显式调用。模型协议测试使用受控服务，无需付费密钥。

本轮开发期间的完整后端回归共 1,307 项，1,297 项通过、7 项失败、1 项超时取消、2 项跳过。修正后的相关用例定点复测 9/9 通过，未重新运行整轮后端测试。

## 上一版本的验证记录

- preview5 冻结实包覆盖暂停去重、25 个桌面场景、正常关窗及 2,488 个恢复归档成员。完整后端第 14 轮为 1,333 通过、4 失败、2 跳过；CLI/MCP 子测试与父测试各计了一次失败。涉及暂停后恢复审批、CLI 访问后台及 MCP 初始化。随后三个测试文件在原时限下单独通过 17/17，原整轮失败的根因尚未确定。
- 冻结的旧版模型矩阵共 3,024 项，893 完成、426 失败、2 未知、1,703 未派发，评分尚未开始。
- 24 小时、72 小时和 20 天连续运行均待验。preview4 的自然观察段为 236.481 秒；preview5 的关窗观察为 30.347 秒。
- 可选 IDE 的原生编辑、保存、撤销及 TypeScript 服务已实测。独立验收中一次终端输入回执超时，复验该项通过，后续任务控制步骤出现一次后台连接失败。IDE 整套验收仍待通过。
- 本次交付源码。构建与测试命令见 [贡献指南](CONTRIBUTING.md)。

自有代码沿用 [Apache-2.0](LICENSE)。第三方组件保留 [DSH MIT](licenses/DSH-MIT.txt)、[Node 许可](licenses/node-v24.16.0-LICENSE.txt)及其各自声明。品牌图的使用范围见 [素材来源](assets/brand/SOURCE.md)。
