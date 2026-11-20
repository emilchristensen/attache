import { z } from "zod";
import { CoverageState } from "./features.ts";

export const AgendaEvent = z.object({
  id: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  title: z.string(),
  response: z.string(),
  calendarUrl: z.string().url().nullable(),
  meetLink: z.string().url().nullable(),
});

export type AgendaEvent = z.infer<typeof AgendaEvent>;

export const AgendaResponse = z.object({
  connection: z.object({
    id: z.string(),
    status: z.enum(["connected", "needs_auth", "error", "disconnected", "not_configured"]),
  }).nullable(),
  events: z.array(AgendaEvent),
  readAt: z.string().nullable(),
  coverage: z.object({
    state: CoverageState,
    scopes: z.array(z.object({ scope: z.string(), state: CoverageState, items: z.number(), pages: z.number(), note: z.string().optional() })),
    items: z.number(),
    at: z.string(),
    note: z.string().optional(),
  }).nullable(),
});

export type AgendaResponse = z.infer<typeof AgendaResponse>;
