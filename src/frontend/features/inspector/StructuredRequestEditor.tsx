import { useEffect, useRef, useState } from 'react';
import { Button, ErrorBanner } from '../../components/ui';
import { Field } from '../pages/ModelEditor';
import { requestObject } from './request-draft';

const known = new Set(['model', 'temperature', 'max_tokens', 'messages', 'tools', 'tool_choice', 'context']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Invalid JSON stays visible in the field, and disables every action that consumes this draft. */
function JsonField({ label, value, onChange, onError, validate }: { label: string; value: unknown; onChange: (value: unknown) => void; onError: (error: string | undefined) => void; validate?: (value: unknown) => boolean }) {
  const serialized = value === undefined ? '' : JSON.stringify(value, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string>();
  useEffect(() => { setText(serialized); setError(undefined); onError(undefined); }, [serialized]);
  return <Field label={label} error={error}><span className="prompt-edit"><textarea aria-label={label} rows={4} value={text} onChange={event => {
    const next = event.target.value; setText(next);
    try {
      const parsed: unknown = next.trim() ? JSON.parse(next) : undefined;
      if (validate && parsed !== undefined && !validate(parsed)) throw new Error('JSON 类型不符合此字段要求');
      setError(undefined); onError(undefined); onChange(parsed);
    } catch (failure) { const message = (failure as Error).message; setError(message); onError(message); }
  }} /></span></Field>;
}

export function StructuredRequestEditor({ value, onChange, onInvalid }: { value: string; onChange: (value: string) => void; onInvalid: (invalid: boolean) => void }) {
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const errorRef = useRef(errors);
  const invalid = Object.values(errors).some(Boolean);
  let body: Record<string, unknown>;
  try { body = requestObject(value); } catch (error) { return <ErrorBanner message={`请先在 Raw Body 修正 JSON：${(error as Error).message}`} />; }
  const patch = (key: string, next: unknown) => {
    const updated = { ...body };
    if (next === undefined) delete updated[key]; else updated[key] = next;
    onChange(JSON.stringify(updated, null, 2));
  };
  const errorAt = (key: string) => (message: string | undefined) => {
    if (errorRef.current[key] === message) return;
    errorRef.current = { ...errorRef.current, [key]: message };
    setErrors(errorRef.current); onInvalid(Object.values(errorRef.current).some(Boolean));
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const updateMessage = (index: number, patchValue: Record<string, unknown>) => patch('messages', messages.map((message, at) => at === index && object(message) ? { ...message, ...patchValue } : message));
  const move = (index: number, delta: number) => { const next = [...messages]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; patch('messages', next); };
  const extras = Object.fromEntries(Object.entries(body).filter(([key]) => !known.has(key)));
  return <div className="model-form">
    <div className="set-note">结构化编辑与 Raw Body 共用草稿。未知服务商参数和消息附加字段会保留；清空字段即移除覆盖。</div>
    {invalid && <ErrorBanner message="结构化字段包含无效 JSON；请修正后再导出、保存或发送。Raw Body 保留最后一次有效值。" />}
    <Field label="model"><input className="input mono" value={typeof body.model === 'string' ? body.model : ''} onChange={event => patch('model', event.target.value || undefined)} /></Field>
    <div className="model-form__grid">
      <JsonField label="temperature" value={body.temperature} onChange={next => patch('temperature', next)} onError={errorAt('temperature')} validate={next => typeof next === 'number' && Number.isFinite(next) && next >= 0 && next <= 2} />
      <JsonField label="max_tokens" value={body.max_tokens} onChange={next => patch('max_tokens', next)} onError={errorAt('max_tokens')} validate={next => typeof next === 'number' && Number.isInteger(next) && next > 0} />
    </div>
    <div className="form-field"><span className="form-field__label">消息与顺序</span>
      {messages.map((message, index) => object(message) ? <div className="full-msg col" key={index}>
        <div className="raw__actions"><label className="form-field">角色 {index + 1}<select className="input" aria-label={`消息 ${index + 1} 角色`} value={String(message.role ?? '')} onChange={event => updateMessage(index, { role: event.target.value })}>
          {!['system', 'developer', 'user', 'assistant', 'tool'].includes(String(message.role)) && <option value={String(message.role ?? '')}>{String(message.role ?? '未指定')}</option>}
          {['system', 'developer', 'user', 'assistant', 'tool'].map(role => <option key={role}>{role}</option>)}
        </select></label><span className="grow" />
          <Button size="sm" aria-label={`上移消息 ${index + 1}`} disabled={index === 0 || invalid} onClick={() => move(index, -1)}>上移</Button>
          <Button size="sm" aria-label={`下移消息 ${index + 1}`} disabled={index === messages.length - 1 || invalid} onClick={() => move(index, 1)}>下移</Button>
          <Button size="sm" aria-label={`删除消息 ${index + 1}`} disabled={invalid} onClick={() => patch('messages', messages.filter((_, at) => at !== index))}>删除</Button>
        </div>
        {typeof message.content === 'string' ? <Field label={`消息 ${index + 1} 内容`}><span className="prompt-edit"><textarea aria-label={`消息 ${index + 1} 内容`} rows={3} value={message.content} onChange={event => updateMessage(index, { content: event.target.value })} /></span></Field>
          : <JsonField label={`消息 ${index + 1} 内容 JSON`} value={message.content} onChange={content => updateMessage(index, { content })} onError={errorAt(`message-${index}`)} />}
      </div> : <div key={index} className="set-note">消息 {index + 1} 不是对象，请使用下方 messages JSON 编辑。</div>)}
      <Button size="sm" icon="plus" disabled={invalid} onClick={() => patch('messages', [...messages, { role: 'user', content: '' }])}>添加消息</Button>
    </div>
    <JsonField label="messages JSON（含消息附加字段）" value={body.messages} onChange={next => patch('messages', next)} onError={errorAt('messages')} validate={Array.isArray} />
    <JsonField label="tools JSON" value={body.tools} onChange={next => patch('tools', next)} onError={errorAt('tools')} validate={Array.isArray} />
    <JsonField label="tool_choice JSON" value={body.tool_choice} onChange={next => patch('tool_choice', next)} onError={errorAt('tool_choice')} />
    <JsonField label="context JSON" value={body.context} onChange={next => patch('context', next)} onError={errorAt('context')} />
    <JsonField label="额外服务商参数 JSON" value={extras} onError={errorAt('extras')} validate={next => object(next) && Object.keys(next).every(key => !known.has(key))} onChange={next => onChange(JSON.stringify({ ...Object.fromEntries(Object.entries(body).filter(([key]) => known.has(key))), ...(object(next) ? next : {}) }, null, 2))} />
  </div>;
}
