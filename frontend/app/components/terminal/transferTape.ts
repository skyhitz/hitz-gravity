/**
 * The HITZ Terminal's transfer tape: the rows of the "Institutional and whale flows" card, newest first.
 * The live poll (the head) adds new transfers on top, and scrolling asks for the page before the oldest
 * row held, back as far as the viewer's plan reaches. What a plan sees is still decided by the server
 * (functions/_lib/terminal/gate.ts); this decides which pages to ask for and how the answers join up, so
 * no transfer is lost, shown twice or silently skipped.
 *
 * Pure and erasable TypeScript, run in Node by tests/terminal-transfer-tape.test.mjs. House style: no em-dashes.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The head: the newest transfers of the last week, polled. */
export const HEAD_ROWS = 50;
export const HEAD_SPAN_MS = 7 * DAY_MS;
/** Each older page. */
export const PAGE_ROWS = 100;
/** The first day any series can have (gate.ts FIRST_DAY): asking from it asks for all of it, and the gate cuts it to the plan. */
export const ALL_FROM = "2015-01-01";

export interface TapeRow {
  op_id: string;
  closed_at: string;
}

/** The part of an answer's meta block the tape reads. */
export interface TapeMeta {
  plan: string;
  from?: string;
  to?: string;
}

export type TapeStatus = "more" | "loading" | "error" | "end";

/** Where the tape ended: at the plan's reach (`cut`), or at the start of the record. */
export interface TapeEnd {
  plan: string;
  from: string | null;
  cut: boolean;
}

export interface Tape<T extends TapeRow> {
  /** Newest first, one per transfer. */
  rows: T[];
  /** The plan the rows were read with. */
  plan: string | null;
  /** The end of the latest head's window: the tape holds every transfer from its oldest row to here. */
  topMs: number | null;
  /** Bumped when the tape starts over, so a page asked for before is dropped. */
  gen: number;
  status: TapeStatus;
  /** The last full page added nothing: ask strictly before the oldest row instead of re-reading its minute. */
  strict: boolean;
  error: string | null;
  end: TapeEnd | null;
}

const ms = (iso: string | undefined): number => (iso === undefined ? Number.NaN : Date.parse(iso));

/** Op ids are int64s as text: the longer one is larger. Larger first. */
const opDesc = (a: string, b: string): number => b.length - a.length || (a < b ? 1 : a > b ? -1 : 0);
const newestFirst = (a: TapeRow, b: TapeRow): number => ms(b.closed_at) - ms(a.closed_at) || opDesc(a.op_id, b.op_id);

export function emptyTape<T extends TapeRow>(): Tape<T> {
  return { rows: [], plan: null, topMs: null, gen: 0, status: "more", strict: false, error: null, end: null };
}

/** Every transfer of both, once (the fresh copy wins), newest first. */
export function mergeRows<T extends TapeRow>(held: readonly T[], fresh: readonly T[]): T[] {
  const byOp = new Map<string, T>();
  for (const r of held) byOp.set(r.op_id, r);
  for (const r of fresh) byOp.set(r.op_id, r);
  return [...byOp.values()].sort(newestFirst);
}

/**
 * Fold in a head answer: the newest `limit` transfers of its window. The head holds every transfer from
 * its window's start on, or from its oldest row when the limit cut it short. When that is later than the
 * top of the tape (the tab slept), transfers in between may be missing, so the tape starts over from the
 * head, as it does under another plan.
 */
export function withHead<T extends TapeRow>(t: Tape<T>, rows: readonly T[], meta: TapeMeta, limit = HEAD_ROWS): Tape<T> {
  const head = mergeRows([], rows);
  const from = ms(meta.from);
  const reach = head.length >= limit ? ms(head[head.length - 1].closed_at) : Number.isFinite(from) ? from : -Infinity;
  const to = ms(meta.to);
  if (t.plan !== meta.plan || (t.topMs !== null && reach > t.topMs)) {
    return { rows: head, plan: meta.plan, topMs: Number.isFinite(to) ? to : null, gen: t.gen + 1, status: "more", strict: false, error: null, end: null };
  }
  return { ...t, rows: mergeRows(t.rows, head), topMs: Number.isFinite(to) ? Math.max(t.topMs ?? to, to) : t.topMs };
}

/**
 * The next older page: everything before the end of the oldest row's minute. Free answers are cached with
 * `to` rounded down to the minute, so a whole minute is asked for; the rows it repeats (the oldest one and
 * any sharing its second) are dropped by op id.
 */
export function olderQuery<T extends TapeRow>(t: Tape<T>, limit = PAGE_ROWS): { from: string; to?: number; limit: number } {
  const oldest = t.rows[t.rows.length - 1];
  if (!oldest) return { from: ALL_FROM, limit };
  const at = ms(oldest.closed_at);
  return { from: ALL_FROM, to: t.strict ? at : Math.ceil((at + 1) / MINUTE_MS) * MINUTE_MS, limit };
}

/** A page is on its way. */
export function asking<T extends TapeRow>(t: Tape<T>, gen: number): Tape<T> {
  return gen === t.gen ? { ...t, status: "loading", error: null } : t;
}

/** A page did not come, and why. */
export function failed<T extends TapeRow>(t: Tape<T>, gen: number, error: string): Tape<T> {
  return gen === t.gen ? { ...t, status: "error", error } : t;
}

/**
 * Fold in an older page. Fewer rows than asked for means nothing older in the window: the end, at the
 * plan's reach when the gate moved `from` later than asked (meta.from), else at the start of the record.
 */
export function withOlder<T extends TapeRow>(t: Tape<T>, gen: number, rows: readonly T[], meta: TapeMeta, limit = PAGE_ROWS): Tape<T> {
  if (gen !== t.gen) return t;
  if (meta.plan !== t.plan) return failed(t, gen, "The plan changed. Try again in a moment.");
  const merged = mergeRows(t.rows, rows);
  if (rows.length < limit) {
    return { ...t, rows: merged, status: "end", strict: false, error: null, end: { plan: meta.plan, from: meta.from ?? null, cut: ms(meta.from) > ms(ALL_FROM) } };
  }
  return { ...t, rows: merged, status: "more", strict: merged.length === t.rows.length, error: null };
}

/** Consecutive rows by UTC day (`2026-11-24`), for the card's day headers. */
export function dayGroups<T extends TapeRow>(rows: readonly T[]): { day: string; rows: T[] }[] {
  const out: { day: string; rows: T[] }[] = [];
  for (const r of rows) {
    const at = ms(r.closed_at);
    const day = Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : r.closed_at.slice(0, 10);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else out.push({ day, rows: [r] });
  }
  return out;
}
