#!/usr/bin/env node
/**
 * Copy the logs that test services left in Attache's temporary folders (Vitest, the browser
 * journeys, the install test) to test-results/service-logs, for CI to upload after a failure.
 * Usage: node scripts/collect-service-logs.mjs [--out <folder>]
 */
import { join, resolve } from "node:path";
import { collectServiceLogs } from "./service-logs.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const at = process.argv.indexOf("--out");
const out = at === -1 ? join(ROOT, "test-results", "service-logs") : resolve(process.argv[at + 1]);

try {
  const copied = collectServiceLogs({ out });
  console.log(`Copied ${copied} service log file(s) to ${out}`);
} catch (e) {
  console.error(`Could not collect service logs: ${e.message}`);
  process.exit(1);
}
