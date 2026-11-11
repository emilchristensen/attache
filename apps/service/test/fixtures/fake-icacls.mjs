#!/usr/bin/env node
/**
 * TEST-ONLY stand-in for Windows `icacls`, selected with JARVIS_ICACLS_BIN.
 * Each call's arguments are appended to `$FAKE_WINDOWS_DIR/acl.jsonl`, with
 * whether the file was still empty, as it must be when it is made private.
 */
import { appendFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(join(process.env.FAKE_WINDOWS_DIR, "acl.jsonl"), `${JSON.stringify({ args, emptyFile: statSync(args[0]).size === 0 })}\n`);
process.stdout.write(`processed file: ${args[0]}\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`);
