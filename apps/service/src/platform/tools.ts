import { existsSync } from "node:fs";
import { platformLocations, toolCandidates, type Env } from "./locations.ts";
import type { Os } from "./os.ts";

/**
 * Where an operating-system tool is installed: the path in `overrideVar`
 * when that variable is set (tests use it to put a stand-in in its place),
 * else the first of the usual install folders that has it. Null when the
 * tool is not installed.
 */
export function locateTool(os: Os, name: string, overrideVar: string, env: Env = process.env): string | null {
  const override = env[overrideVar];
  if (override) return existsSync(override) ? override : null;
  return toolCandidates(platformLocations(os, env), name).find((p) => existsSync(p)) ?? null;
}
