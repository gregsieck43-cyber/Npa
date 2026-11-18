import { useCallback, useEffect, useState } from 'react';
import { GatewayError } from '../../api';
import { useApp } from '../../app/store';

/** Inspector 面板数据：随会话切换和 inspector.invalidated 事件自动重新拉取，错误如实返回给面板呈现。 */
export function useInspectorData<T>(sessionId: string, load: (sessionId: string) => Promise<T>) {
  const revision = useApp(s => s.inspectorRevision[sessionId] ?? 0);
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [manual, setManual] = useState(0);

  useEffect(() => {
    let alive = true;
    setState(current => ({ ...current, loading: true }));
    load(sessionId).then(
      data => { if (alive) setState({ data, loading: false }); },
      (error: unknown) => { if (alive) setState({ error: error instanceof GatewayError || error instanceof Error ? error.message : String(error), loading: false }); },
    );
    return () => { alive = false; };
    // load 由调用方以稳定函数传入
  }, [sessionId, revision, manual]);

  const reload = useCallback(() => setManual(n => n + 1), []);
  return { ...state, reload };
}
