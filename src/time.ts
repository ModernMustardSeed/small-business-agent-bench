// Wall-clock helpers. Every time in a task world is a local wall time in the
// business's own zone, written YYYY-MM-DDTHH:mm. Arithmetic on wall times is
// naive (no DST jump inside a single task), which no task depends on.

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function wallToUtcNaive(wall: string): number {
  const m = WALL.exec(wall);
  if (!m) throw new Error(`not a date-time: ${wall}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** Clock reading of a naive UTC millisecond value: [0 to 23, 0 to 59]. */
function clockOf(ms: number): [number, number] {
  const minuteOfDay = ((Math.floor(ms / 60000) % 1440) + 1440) % 1440;
  return [Math.floor(minuteOfDay / 60), minuteOfDay % 60];
}

export function naiveToWall(ms: number): string {
  const d = new Date(ms);
  const [h, m] = clockOf(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(h)}:${pad(m)}`;
}

/** Minutes the zone is ahead of UTC at the given instant, read from the zone's own offset name (GMT-04:00). */
export function zoneOffsetMinutes(tz: string, instantMs: number): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(new Date(instantMs))
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -minutes : minutes;
}

export function wallToInstant(wall: string, tz: string): number {
  const naive = wallToUtcNaive(wall);
  let instant = naive - zoneOffsetMinutes(tz, naive) * 60000;
  instant = naive - zoneOffsetMinutes(tz, instant) * 60000;
  return instant;
}

export function instantToWall(instantMs: number, tz: string): string {
  return naiveToWall(instantMs + zoneOffsetMinutes(tz, instantMs) * 60000);
}

/**
 * Accepts what a model is likely to send: a local wall time, a date with
 * seconds, or an ISO string with an offset or Z. Returns the business-zone wall
 * time, or null when the string is not a date-time.
 */
export function normalizeWall(input: unknown, tz: string): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const m = WALL.exec(s);
  if (!m) return null;
  if (m[7]) {
    const instant = Date.parse(s.length === 16 ? s + ':00' : s);
    if (Number.isNaN(instant)) return null;
    return instantToWall(instant, tz);
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

export function normalizeDate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function addMinutes(wall: string, minutes: number): string {
  return naiveToWall(wallToUtcNaive(wall) + minutes * 60000);
}

export function addDays(date: string, days: number): string {
  return naiveToWall(wallToUtcNaive(`${date}T00:00`) + days * 86400000).slice(0, 10);
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export function weekdayOf(dateOrWall: string): (typeof DAYS)[number] {
  return DAYS[new Date(wallToUtcNaive(dateOrWall.slice(0, 10) + 'T00:00')).getUTCDay()];
}

export function describeWall(wall: string): string {
  const ms = wallToUtcNaive(wall);
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const [h, m] = clockOf(ms);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${day}, ${h12}:${pad(m)} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

/** Clock reading (0 to 23) at which a business-zone wall time falls for someone in another zone. */
export function recipientClock(wall: string, businessTz: string, recipientTz: string): number {
  const instant = wallToInstant(wall, businessTz);
  return Number(instantToWall(instant, recipientTz).slice(11, 13));
}
