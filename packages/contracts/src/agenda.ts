import { z } from "zod";
import { ConnectionStatusState, Coverage } from "./features.ts";

/** `GET /agenda`'s query: an instant range, its start before its end. */
export const AgendaQuery = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), { message: "The agenda range must start before it ends" });

/** One calendar event as `GET /agenda` returns it, from what the calendar Connection last read. */
export const AgendaEvent = z.object({
  id: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  title: z.string(),
  /** The owner's own answer: accepted, tentative, needsAction (not answered) or declined. */
  response: z.string(),
  calendarUrl: z.string().url().nullable(),
  meetLink: z.string().url().nullable(),
});

export type AgendaEvent = z.infer<typeof AgendaEvent>;

/** `GET /agenda?from=&to=`: the events in the range, when the calendar was last read, and that read's coverage. */
export const AgendaResponse = z.object({
  connection: z.object({ id: z.string(), status: ConnectionStatusState }).nullable(),
  events: z.array(AgendaEvent),
  readAt: z.string().nullable(),
  coverage: Coverage.nullable(),
});

export type AgendaResponse = z.infer<typeof AgendaResponse>;
