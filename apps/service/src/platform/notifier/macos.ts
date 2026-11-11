import { existsSync } from "node:fs";
import { run } from "../run.ts";
import type { Notifier } from "./types.ts";

const OSASCRIPT = "/usr/bin/osascript";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ").slice(0, 240);

/** Notification Center through osascript. The script text is passed on stdin, never as a shell string. */
export const macosNotifier: Notifier = {
  async notify(title, body) {
    if (!existsSync(OSASCRIPT)) return false;
    const r = await run(OSASCRIPT, ["-"], { input: `display notification "${esc(body)}" with title "Jarvis" subtitle "${esc(title)}"`, timeoutMs: 5000 });
    return r.code === 0;
  },
};
