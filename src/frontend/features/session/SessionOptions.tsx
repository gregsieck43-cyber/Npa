import { useEffect, useState } from 'react';
import { gateway } from '../../api';
import type { SessionCapabilities, SessionSettingsView } from '../../api/library-types';
import { promote } from '../../app/actions';
import { useApp } from '../../app/store';
import { Button, ErrorBanner, Modal, Skeleton, Switch } from '../../components/ui';
import { Field } from '../pages/ModelEditor';
import { downloadJson, requestObject } from '../inspector/request-draft';

const capabilities: { key: keyof SessionCapabilities; label: string }[] = [
  { key: 'web', label: '联网搜索' }, { key: 'tools', label: '工具' }, { key: 'mcp', label: 'MCP' }, { key: 'skills', label: 'Skills' }, { key: 'projectInstructions', label: '项目指令' },
];

export function SessionOptions({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const session = useApp(state => state.sessions[sessionId]);
  const [settings, setSettings] = useState<SessionSettingsView>();
  const [parameters, setParameters] = useState('{}');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [part, setPart] = useState(0);
  const [exportDone, setExportDone] = useState(false);
  useEffect(() => {
    let alive = true;
    gateway.library.sessionSettings(sessionId).then(value => { if (alive) { setSettings(value); setParameters(JSON.stringify(value.parameters, null, 2)); } }, failure => { if (alive) setError((failure as Error).message); });
    return () => { alive = false; };
  }, [sessionId]);
  let parameterError: string | undefined;
  try { requestObject(parameters); } catch (failure) { parameterError = (failure as Error).message; }
  const save = async () => {
    if (!settings || parameterError) return; setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const saved = await gateway.library.saveSessionSettings(sessionId, { parameters: requestObject(parameters), capabilities: settings.capabilities });
      setSettings(saved); setParameters(JSON.stringify(saved.parameters, null, 2)); setNotice('已保存；仅影响后续请求，历史请求保持不变。');
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const exportPage = async () => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const page = await gateway.library.exportConversation(sessionId, { cursor, limit: 30 });
      downloadJson(`${sessionId}-conversation-part-${part + 1}.json`, { ...page, part: part + 1 });
      setPart(current => current + 1); setCursor(page.nextCursor); setExportDone(!page.nextCursor);
      setNotice(`第 ${part + 1} 页已交给浏览器下载（快照 ${page.snapshot}）${page.nextCursor ? '；仍有后续页，请继续导出。' : '；此快照已全部导出。'}`);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} title="会话高级设置与导出" width={620} footer={<><Button variant="ghost" onClick={onClose}>关闭</Button><span className="grow" /><Button variant="primary" disabled={busy || !settings || !!parameterError} onClick={() => void save()}>{busy ? '处理中…' : '保存会话设置'}</Button></>}>
    <div className="model-form">
      {error && <ErrorBanner message={error} />}{notice && <div className="set-note" role="status">{notice}</div>}
      {!settings ? !error && <Skeleton lines={4} /> : <>
        <div className="set-note">作用域：此会话。模型 {settings.model}；输出上限 {settings.maxOutputTokens} tokens。能力开关不会增加执行权限。</div>
        {capabilities.map(({ key, label }) => <div key={key} className="col"><div className="model-form__row"><span className="form-field__label">{label}</span><Switch label={label} checked={settings.capabilities[key]} disabled={busy || !settings.supported[key]} onChange={enabled => setSettings(current => current ? { ...current, capabilities: { ...current.capabilities, [key]: enabled } } : current)} /></div>{!settings.supported[key] && <div className="set-note">{settings.unsupportedReasons[key] ?? '此会话不支持此能力'}</div>}</div>)}
        {settings.supported.mcp && <div className="set-note">MCP 仅提供已批准服务声明为只读的工具；先在设置连接服务器。写入或行为未知的工具请使用 Cowork。</div>}
        {session?.mode === 'chat' && !settings.supported.mcp && <Button size="sm" disabled={busy} onClick={() => { void promote(sessionId, session.title, ['目标完成且有可验证证据']); onClose(); }}>升级为 Cowork 以使用 MCP</Button>}
        <Field label="会话参数覆盖 JSON" error={parameterError}><span className="prompt-edit"><textarea aria-label="会话参数覆盖 JSON" rows={7} value={parameters} disabled={busy} onChange={event => setParameters(event.target.value)} /></span></Field>
        <div className="set-note">例如 temperature、max_tokens 与服务商额外参数；空对象恢复默认。模型预设沿用模型选择器与设置中的模型配置。后台会校验模型能力和允许的参数。</div>
      </>}
      <div className="form-field"><span className="form-field__label">导出当前会话与请求数据</span><div className="set-note">每次下载一页固定快照，包含当前会话的消息、请求与必要的大记录分片；不包含来源会话档案。保留全部 part 文件；按 section、id、offset 连接 fragments 中的 json 字段可还原大记录。此操作不调用模型。</div><div className="raw__actions"><Button disabled={busy || exportDone} icon="download" onClick={() => void exportPage()}>{part ? `继续导出第 ${part + 1} 页` : '导出第 1 页'}</Button>{part > 0 && <Button disabled={busy} variant="ghost" onClick={() => { setCursor(undefined); setPart(0); setExportDone(false); setNotice(undefined); }}>开始新快照</Button>}</div></div>
    </div>
  </Modal>;
}
