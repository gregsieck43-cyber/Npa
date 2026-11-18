import { append, button, element, testId } from './dom.js';
import { activityLevel, activitySummary, calendarOffset, type ActivityReport } from './activity-model.js';

export function activityHeatmap(report: ActivityReport): HTMLElement {
  const summary = activitySummary(report.days), card = testId(element('section', 'card activity-calendar'), 'activity-heatmap');
  const heading = append(element('div', 'row spread wrap'), append(element('div'), element('h3', '', '每一步，都有记录'), element('p', 'muted tiny', `${report.startDate} — ${report.endDate} · ${report.timezone} · 按持久事件计数`)), element('span', 'activity-period', `${report.days.length} 天`));
  card.append(heading);
  const detail = testId(element('div', 'heatmap-detail'), 'activity-day-detail'); detail.setAttribute('aria-live', 'polite');
  detail.textContent = '选择一天，查看实际活动。空白色块表示当天没有记录。';
  const chart = element('div', 'heatmap-chart'), calendar = element('div', 'heatmap-grid'); calendar.setAttribute('aria-label', '每日活动日历');
  const weekdays = element('div', 'heatmap-weekdays'); ['一', '二', '三', '四', '五', '六', '日'].forEach(day => weekdays.append(element('span', '', day)));
  const maximum = Math.max(0, ...report.days.map(day => day.events));
  for (let i = 0; i < (report.days.length ? calendarOffset(report.days[0].date) : 0); i++) { const blank = element('span', 'heatmap-cell padding'); blank.setAttribute('aria-hidden', 'true'); calendar.append(blank); }
  for (const day of report.days) {
    const label = `${day.date}：${day.events} 条事件，${day.modelCalls} 次模型调用，${day.toolEffects} 次工具效果，创建 ${day.tasksCreated} 个任务，完成 ${day.tasksCompleted} 个任务`;
    const cell = button('', () => { detail.textContent = label; calendar.querySelector('.selected')?.classList.remove('selected'); cell.classList.add('selected'); }, `heatmap-cell level-${activityLevel(day.events, maximum)}`);
    cell.dataset.date = day.date; cell.dataset.events = String(day.events); cell.title = label; cell.setAttribute('aria-label', label);
    cell.addEventListener('keydown', event => {
      const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key]; if (step === undefined) return;
      event.preventDefault(); const cells = [...calendar.querySelectorAll<HTMLButtonElement>('button')], index = cells.indexOf(cell); cells[index + step]?.focus();
    });
    calendar.append(cell);
  }
  const legend = append(element('div', 'heatmap-legend'), element('span', '', '少'));
  for (let i = 0; i <= 4; i++) legend.append(element('i', `heatmap-cell level-${i}`)); legend.append(element('span', '', '多'));
  chart.append(append(element('div', 'heatmap-calendar-row'), weekdays, calendar), legend);
  const totals = element('div', 'heatmap-totals');
  for (const [value, label] of [[summary.activeDays, '活跃天数'], [summary.longestStreak, '最长连续天数'], [summary.events, '持久事件']] as const) totals.append(append(element('div'), element('strong', '', value.toLocaleString()), element('span', '', label)));
  card.append(append(element('div', 'heatmap-layout'), chart, totals), detail);
  const tableView = element('details', 'activity-table'); tableView.append(element('summary', '', '查看每日原始计数表'));
  tableView.addEventListener('toggle', () => {
    if (!tableView.open || tableView.querySelector('table')) return;
    const table = element('table', 'table'), head = element('thead'), columns = element('tr');
    for (const label of ['日期', '持久事件', '模型调用', '工具效果', '完成任务']) columns.append(element('th', '', label));
    head.append(columns); table.append(head); const body = element('tbody');
    for (const day of report.days) { const row = element('tr'); for (const value of [day.date, day.events, day.modelCalls, day.toolEffects, day.tasksCompleted]) row.append(element('td', '', String(value))); body.append(row); }
    table.append(body); tableView.append(table);
  });
  card.append(tableView);
  if (!summary.events) card.append(element('p', 'heatmap-empty tiny muted', '还没有活动。开始第一个任务后，这里会逐日呈现工作轨迹。'));
  return card;
}
