import { existsSync } from "node:fs";
import { run } from "../run.ts";
import type { Notifier, NotifierState } from "./types.ts";

const OSASCRIPT = "/usr/bin/osascript";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ").slice(0, 240);

const check = async (): Promise<NotifierState> => (existsSync(OSASCRIPT) ? { available: true } : { available: false, reason: `${OSASCRIPT} is missing` });

/** Notification Center through osascript. The script text is passed on stdin, never as a shell string. */
export const macosNotifier: Notifier = {
  check,
  forget: async () => {},
  async notify(title, body) {
    const state = await check();
    if (!state.available) return state;
    const r = await run(OSASCRIPT, ["-"], { input: `display notification "${esc(body)}" with title "Attache" subtitle "${esc(title)}"`, timeoutMs: 5000 });
    return r.code === 0 ? { available: true } : { available: false, reason: r.stderr.trim() || `osascript exited with ${r.code}` };
  },
};
