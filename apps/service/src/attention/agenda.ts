import type { AgendaResponse } from "@attache/contracts";
import { json, type Db } from "../core/db.ts";
import type { ConnectionManager } from "../connectors/manager.ts";

interface AgendaRow {
  external_id: string;
  title: string;
  url: string | null;
  data: string;
  removed_at: string | null;
}

/**
 * An all-day event is a date with no zone, so which instants it covers depends on the owner's zone: it is kept when it
 * overlaps the range widened by the largest offset any zone has from UTC, and the Dashboard decides its day.
 */
const WIDEST_ZONE_OFFSET_MS = 14 * 60 * 60_000;

/**
 * The calendar events that overlap `from` to `to` (ISO instants, validated by the route), from what the calendar
 * Connection last read, without those the owner declined, all-day events first, then by start.
 */
export function agenda(db: Db, connections: ConnectionManager, from: string, to: string): AgendaResponse {
  const rangeStart = Date.parse(from);
  const rangeEnd = Date.parse(to);
  const rec = connections.record("gcal");
  if (!rec) return { connection: null, events: [], readAt: null, coverage: null };
  const status = connections.status(rec);
  const rows = db.prepare("select external_id, title, url, data, removed_at from observations where connection_id = ? and kind = 'calendar_event' and removed_at is null").all(rec.id) as unknown as AgendaRow[];
  const events = rows.flatMap((row) => {
    const data = json<Record<string, unknown>>(row.data, {});
    const start = typeof data.start === "string" ? data.start : null;
    const end = typeof data.end === "string" ? data.end : null;
    if (!start || !end) return [];
    const allDay = data.allDay === true;
    const startMs = eventTime(start);
    const endMs = eventTime(end);
    const pad = allDay ? WIDEST_ZONE_OFFSET_MS : 0;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= rangeEnd + pad || endMs <= rangeStart - pad) return [];
    if (data.selfResponseStatus === "declined") return [];
    return [{
      id: row.external_id,
      start,
      end,
      allDay,
      title: row.title,
      response: typeof data.selfResponseStatus === "string" ? data.selfResponseStatus : "needsAction",
      calendarUrl: row.url,
      meetLink: typeof data.meetLink === "string" ? data.meetLink : null,
    }];
  }).sort((a, b) => Number(b.allDay) - Number(a.allDay) || eventTime(a.start) - eventTime(b.start) || a.id.localeCompare(b.id));
  return { connection: { id: rec.id, status: rec.status }, events, readAt: status.lastReadAt, coverage: status.coverage };
}

function eventTime(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00Z`);
  return Date.parse(value);
}
