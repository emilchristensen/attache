import { z } from "zod";
import { FeatureId } from "./features.ts";

/** API contract: Configuration. */

export const Schedules = z.object({
  syncEveryMinutes: z.number().int().min(5).max(24 * 60).default(30),
  briefingAt: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
  briefingEnabled: z.boolean().default(true),
});

export const Notifications = z.object({
  desktop: z.boolean().default(false),
  quietHours: z.object({ start: z.string(), end: z.string() }).nullable().default(null),
});

export const ModelSettings = z.object({
  provider: z.enum(["none", "claude-cli", "anthropic", "openai-compatible"]).default("none"),
  model: z.string().default(""),
  baseUrl: z.string().default(""),
});

export const Config = z.object({
  schemaVersion: z.literal(1).default(1),
  setupCompleted: z.boolean().default(false),
  setupStep: z.number().int().min(0).default(0),
  dataFolder: z.string().nullable().default(null),
  features: z.partialRecord(FeatureId, z.boolean()).default({}),
  schedules: Schedules.default({ syncEveryMinutes: 30, briefingAt: "08:00", briefingEnabled: true }),
  notifications: Notifications.default({ desktop: false, quietHours: null }),
  identity: z.object({ name: z.string(), email: z.string() }).nullable().default(null),
});
export type Config = z.infer<typeof Config>;

export const ConfigPatch = z.object({
  setupCompleted: z.boolean().optional(),
  setupStep: z.number().int().min(0).optional(),
  features: z.partialRecord(FeatureId, z.boolean()).optional(),
  schedules: Schedules.partial().optional(),
  notifications: Notifications.partial().optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatch>;

/** The computer this service runs on. The id never changes; the owner can rename it. */
export const MACHINE_NAME_MAX = 64;
export const MachineView = z.object({ id: z.string(), name: z.string() });
export type MachineView = z.infer<typeof MachineView>;

export const MachineRename = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the Machine a name")
    .max(MACHINE_NAME_MAX, `Keep the Machine's name to ${MACHINE_NAME_MAX} characters`)
    .refine((n) => !/\p{Cc}/u.test(n), "A Machine's name cannot hold control characters"),
});
export type MachineRename = z.infer<typeof MachineRename>;
