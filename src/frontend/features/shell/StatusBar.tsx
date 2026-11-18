import { openInspector, openSettings } from '../../app/actions';
import { useApp } from '../../app/store';
import { Icon } from '../../components/Icon';
import { StatusDot } from '../../components/ui';
import { cacheHitRateLabel, coverageHint, duration, metricTokens, percent } from '../../lib/format';

export function StatusBar() {
  const connection = useApp(s => s.connection);
  const sessionId = useApp(s => (s.view.kind === 'session' ? s.view.id : undefined));
  const metrics = useApp(s => (sessionId ? s.metrics[sessionId] : undefined));
  const session = useApp(s => (sessionId ? s.sessions[sessionId] : undefined));
  const model = useApp(s => s.models.find(m => m.id === (session?.modelId ?? s.settings?.defaults.modelId)));
  const coverage = metrics?.usageCoverage;
  // 缺少覆盖信息（旧后端/演示网关）时保持原有显示。
  // 命中率按匹配行覆盖；旧后端没有 cacheRatio 时回退旧字段以保持原显示。
  const cacheLabel = cacheHitRateLabel(metrics?.cacheHitRate, coverage?.cacheRatio ?? coverage?.cached);
  const unavailable = <span className="muted">服务商未返回</span>;
  return (
    <footer className="statusbar">
      <span className="statusbar__item">
        <StatusDot tone={connection?.status === 'online' ? 'ok' : connection?.status === 'offline' ? 'danger' : 'warn'} pulse={connection?.status === 'connecting'} />
        {connection?.status === 'online' ? '后台在线' : connection?.status === 'offline' ? '后台离线' : '连接中'}
        {connection?.latencyMs !== undefined && <span className="muted num">{connection.latencyMs}ms</span>}
      </span>
      {connection?.demo && <span className="demo-badge" title="当前使用前端演示网关，所有会话、指标与热力图都是演示数据，不代表真实运行记录。"><Icon name="sparkles" size={11} />演示数据</span>}
      {model && <span className="statusbar__item"><Icon name="cpu" size={12} />{model.name}<span className={`model-mode model-mode--${model.mode}`}>{model.mode}</span></span>}
      <span className="grow" />
      {metrics && (
        <>
          <span className="statusbar__item" title="用户轮次 / 实际模型步数">轮次 <strong className="num">{metrics.rounds}</strong> · 步 <strong className="num">{metrics.modelSteps}</strong></span>
          <span className="statusbar__item" title="累计输入 / 输出 tokens"><Icon name="arrowUp" size={11} /><span className="num" title={coverageHint(coverage?.input)}>{metricTokens(metrics.tokens.input, coverage?.input)}</span><Icon name="arrowUp" size={11} className="flip" /><span className="num" title={coverageHint(coverage?.output)}>{metricTokens(metrics.tokens.output, coverage?.output)}</span></span>
          <span className="statusbar__item" title="缓存命中率">缓存 {cacheLabel !== undefined ? <strong className="num">{cacheLabel}</strong> : unavailable}</span>
          <span className="statusbar__item" title="最近请求耗时与均速">延迟 {metrics.lastLatencyMs !== undefined ? <strong className="num">{duration(metrics.lastLatencyMs)}</strong> : unavailable}{metrics.tokensPerSecond ? <span className="muted num"> · {metrics.tokensPerSecond.toFixed(0)} tok/s</span> : null}</span>
          <button type="button" className="statusbar__item statusbar__btn" onClick={() => openInspector('tools')} title="工具调用 / 活跃中"><Icon name="wrench" size={12} /><span className="num">{metrics.toolCalls}</span>{metrics.activeTools > 0 && <span className="statusbar__live num">{metrics.activeTools} 活跃</span>}</button>
          {metrics.contextUsed !== undefined && metrics.contextWindow ? (
            <button type="button" className="statusbar__item statusbar__btn" onClick={() => openInspector('context')} title="最近请求上下文占用">
              <span className="mini-meter"><span style={{ width: `${Math.min(100, (metrics.contextUsed / metrics.contextWindow) * 100)}%` }} /></span>
              <span className="num">{percent(metrics.contextUsed / metrics.contextWindow)}</span>
            </button>
          ) : null}
        </>
      )}
      <button type="button" className="statusbar__item statusbar__btn" onClick={() => openSettings('shortcuts')}><Icon name="keyboard" size={12} />Ctrl+K</button>
    </footer>
  );
}
