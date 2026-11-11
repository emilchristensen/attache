#!/usr/bin/env node
/**
 * TEST-ONLY stand-in for libnotify's `notify-send`, selected with
 * JARVIS_NOTIFY_SEND_BIN. Each notification's arguments are appended to
 * `$FAKE_NOTIFY_LOG` as one JSON line.
 * While a file `$FAKE_NOTIFY_LOG.down` exists it answers like a desktop whose
 * notification service is not running.
 */
import { appendFileSync, existsSync } from "node:fs";

const log = process.env.FAKE_NOTIFY_LOG;
if (existsSync(`${log}.down`)) {
  process.stderr.write("GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.Notifications was not provided by any .service files\n");
  process.exit(1);
}
appendFileSync(log, `${JSON.stringify(process.argv.slice(2))}\n`);
