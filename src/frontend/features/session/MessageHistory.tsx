import { loadLatestMessages, loadOlderMessages } from '../../app/actions';
import { useApp } from '../../app/store';
import { Button } from '../../components/ui';

/** Page replacement keeps both long conversations and retained history bounded. */
export function MessageHistory({ sessionId }: { sessionId: string }) {
  const detail = useApp(state => state.details[sessionId]);
  const window = useApp(state => state.detailSessionId === sessionId ? state.messageWindow : undefined);
  if (!detail || (!detail.hasMoreBefore && !window?.history)) return null;
  return <div className="row gap-2" aria-label="消息历史分页">
    {detail.hasMoreBefore && <Button size="sm" disabled={window?.loading} onClick={() => void loadOlderMessages(sessionId)}>查看更早消息</Button>}
    {window?.history && <><span className="muted">正在查看历史</span><Button size="sm" disabled={window.loading} onClick={() => void loadLatestMessages(sessionId)}>返回最新</Button></>}
  </div>;
}
