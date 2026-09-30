import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ").slice(0, 240);

function inQuietHours(q: { start: string; end: string } | null, now = new Date()): boolean {
  if (!q) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = q.start.split(":").map(Number) as [number, number];
  const [eh, em] = q.end.split(":").map(Number) as [number, number];
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

/**
 * Post a macOS notification through osascript. The script text is passed on
 * stdin, never as a shell string. Returns false when unavailable or suppressed.
 */
export function notifyDesktop(title: string, body: string, opts: { quietHours: { start: string; end: string } | null }): Promise<boolean> {
  if (process.env.JARVIS_NO_NOTIFY === "1" || platform() !== "darwin" || !existsSync("/usr/bin/osascript") || inQuietHours(opts.quietHours)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = execFile("/usr/bin/osascript", ["-"], { timeout: 5000 }, (err) => resolve(!err));
    child.stdin?.end(`display notification "${esc(body)}" with title "Jarvis" subtitle "${esc(title)}"`);
  });
}
