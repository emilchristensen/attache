import { existsSync, readFileSync } from "node:fs";
import { HooksFileError } from "./hooks-config.ts";

/**
 * A Harness's own JSON configuration file, as the Harness reads it: a UTF-8
 * byte-order mark (which Windows editors write) is ignored. Undefined when the
 * file is absent or empty; throws, naming the file and the Harness, when it
 * does not parse or holds something other than an object.
 */
export function readHarnessJson(path: string, harness: string, parse: (text: string) => unknown = JSON.parse): { raw: string; value: Record<string, unknown> } | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    throw new HooksFileError(`${path} is not valid JSON (${(e as Error).message}); fix it so ${harness} can read it, then connect again. Attache changed nothing.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HooksFileError(`${path} does not contain a JSON object; fix it, then connect again. Attache changed nothing.`);
  return { raw, value: parsed as Record<string, unknown> };
}
