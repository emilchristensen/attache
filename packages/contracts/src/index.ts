/** Versioned API contract shared by the service, browser client, CLI and any future client. */
export const API_VERSION = "v1";
export const API_PREFIX = `/api/${API_VERSION}`;

export * from "./features.ts";
export * from "./config.ts";
export * from "./replication.ts";
export * from "./updates.ts";
export * from "./memory.ts";
export * from "./recall-evaluation.ts";
export * from "./meaning.ts";
export * from "./attention.ts";
export * from "./agenda.ts";
export * from "./jobs.ts";
export * from "./actions.ts";
export * from "./decision-count.ts";
export * from "./errors.ts";
export * from "./wording.ts";
export * from "./harness.ts";
