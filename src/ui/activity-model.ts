export interface ActivityDay { date: string; events: number; modelCalls: number; toolEffects: number; tasksCreated: number; tasksCompleted: number; }
export interface ActivityReport { timezone: string; startDate: string; endDate: string; days: ActivityDay[]; }

export function activityLevel(events: number, maximum: number): number {
  return events <= 0 || maximum <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(events / maximum) * 4)));
}

export function activitySummary(days: ActivityDay[]) {
  let longestStreak = 0, streak = 0;
  const total = { events: 0, modelCalls: 0, toolEffects: 0, tasksCreated: 0, tasksCompleted: 0, activeDays: 0 };
  for (const day of days) {
    for (const name of ['events', 'modelCalls', 'toolEffects', 'tasksCreated', 'tasksCompleted'] as const) total[name] += day[name];
    if (day.events > 0) { total.activeDays++; streak++; longestStreak = Math.max(longestStreak, streak); } else streak = 0;
  }
  return { ...total, longestStreak };
}

/** Monday-first calendar padding; empty slots are outside the returned date range. */
export function calendarOffset(date: string): number { return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; }
