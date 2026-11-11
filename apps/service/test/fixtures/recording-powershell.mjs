#!/usr/bin/env node
/**
 * TEST-ONLY: runs the real Windows PowerShell with the same arguments and
 * input, after appending its arguments to `$RECORD_POWERSHELL_LOG`, so tests
 * can check that no secret ever reaches process arguments.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(process.env.RECORD_POWERSHELL_LOG, `${JSON.stringify(args)}\n`);
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const r = spawnSync(powershell, args, { input: Buffer.concat(chunks), windowsHide: true });
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
process.exit(r.status ?? 1);
