#!/usr/bin/env node
/**
 * The requests a failed browser journey made, from its Playwright trace: when each started, its method, address and
 * status, and its request and response bodies, oldest first.
 * Usage: node scripts/trace-requests.mjs <trace.zip> [path filter, default /api/] [--full]
 * --full prints whole bodies; otherwise each is cut to 400 characters.
 */
import { readFileSync } from "node:fs";
import { unzip } from "./trace-requests/zip.mjs";
import { formatRequests, traceRequests } from "./trace-requests/requests.mjs";

const args = process.argv.slice(2);
const full = args.includes("--full");
const [trace, filter = "/api/"] = args.filter((a) => a !== "--full");

try {
  if (!trace) throw new Error("Usage: node scripts/trace-requests.mjs <trace.zip> [path filter, default /api/] [--full]");
  const requests = traceRequests(unzip(readFileSync(trace)), filter);
  process.stdout.write(requests.length ? `${formatRequests(requests, full ? 0 : 400)}\n` : `No request in ${trace} matches ${filter}.\n`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
