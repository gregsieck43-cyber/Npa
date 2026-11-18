import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function agentHtml(webview: vscode.Webview, extension: vscode.Uri): string {
  const nonce = randomBytes(18).toString('hex');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'media', 'agent-ui.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'media', 'agent-ui.css'));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
export function homeHtml(webview: vscode.Webview, extension: vscode.Uri, project: string, version: string): string {
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'media', 'agent-ui.css'));
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'media', 'npn-logo.png'));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource};"><link rel="stylesheet" href="${css}"></head><body class="home-page"><header class="home-top"><span class="wordmark">NPN <span>GAMMA</span></span><span>IDE · ${escape(version)}</span></header><main class="home-content"><img class="home-logo" src="${logo}" alt="NPN"><p class="eyebrow">AGENT-NATIVE WORKSPACE</p><h1>让代码与 Agent<br>在同一工作台协作。</h1><p class="home-description">${escape(project || '选择一个项目，从清晰的目标开始。')}<br>编辑器属于你。目标、记忆与执行由独立 Agent 后台持续管理。</p><div class="home-actions"><a class="primary-link" href="command:npn.openAgent">打开 Agent 工作台 <span>↗</span></a><a class="secondary-link" href="command:npn.openProject">打开项目</a></div><section class="home-features"><article><span>01</span><h3>原生编码</h3><p>文件、语言服务、搜索与终端。<br>保存代码不会启动一次模型调用。</p></article><article><span>02</span><h3>有目标的执行</h3><p>Chat 自由对话，Work 按目标推进。<br>任务、预算、暂停与恢复始终可见。</p></article><article><span>03</span><h3>可核对的行动</h3><p>查看真实请求、工具轨迹与文件 Diff。<br>批准具体变更，而不是相信一句“完成”。</p></article></section></main><footer class="home-footer"><span>工作区 · 独立后台 · 可追溯执行</span><span>基于 Code - OSS · 上游许可保留</span></footer></body></html>`;
}
