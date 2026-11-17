import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { replaceWith } from "../platform/replace-file.ts";

/**
 * Editing the `{ hooks: { Event: [{ matcher, hooks: [{ type, command, timeout }] }] } }`
 * shape that Claude Code, Codex and Gemini CLI share. Attache only ever adds,
 * replaces or removes its own entries (recognised by `isOurs`); every other
 * hook and setting in the file is preserved exactly.
 */
export interface HookSpec {
  event: string;
  matcher?: string;
  command: string;
  timeout: number;
  /** Agent-specific per-hook options, e.g. Codex's `additionalContextLimit`. */
  options?: Record<string, number | string | boolean>;
}

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

export class HooksFileError extends Error {}

function hooksOf(settings: Settings): Record<string, HookGroup[]> {
  const h = settings.hooks;
  if (h === undefined) return {};
  if (!h || typeof h !== "object" || Array.isArray(h)) throw new HooksFileError("The settings file has a `hooks` value that is not an object; Attache will not change it.");
  return h;
}

/** The settings with every Attache-owned hook removed. Groups and events Attache emptied are dropped. */
export function withoutOurHooks(settings: Settings, isOurs: (command: string) => boolean): Settings {
  const hooks = hooksOf(settings);
  const next: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept = groups.flatMap((g) => {
      if (!Array.isArray(g?.hooks)) return [g];
      const entries = g.hooks.filter((e) => !(typeof e?.command === "string" && isOurs(e.command)));
      if (entries.length === g.hooks.length) return [g];
      return entries.length ? [{ ...g, hooks: entries }] : [];
    });
    if (kept.length) next[event] = kept;
  }
  const { hooks: _drop, ...rest } = settings;
  return Object.keys(next).length || settings.hooks !== undefined ? { ...rest, hooks: next } : rest;
}

const groupFor = (s: HookSpec): HookGroup => ({ ...(s.matcher !== undefined ? { matcher: s.matcher } : {}), hooks: [{ type: "command", command: s.command, timeout: s.timeout, ...s.options }] });

/**
 * The settings with exactly `specs` as the Attache-owned hooks, each in its own
 * group. An existing Attache group is updated where it stands, so every other
 * hook keeps its position: Codex records trust per position, and moving a
 * user's hook would quietly stop it from running.
 */
export function withOurHooks(settings: Settings, specs: HookSpec[], isOurs: (command: string) => boolean): Settings {
  const hooks = hooksOf(settings);
  const isOursEntry = (e: HookEntry) => typeof e?.command === "string" && isOurs(e.command);
  const wanted = (event: string) => specs.filter((s) => s.event === event).map(groupFor);
  const next: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    let placed = false;
    const updated = groups.flatMap((g) => {
      if (!Array.isArray(g?.hooks) || !g.hooks.some(isOursEntry)) return [g];
      const foreign = g.hooks.filter((e) => !isOursEntry(e));
      const ours = placed ? [] : wanted(event);
      placed = true;
      return foreign.length ? [{ ...g, hooks: foreign }, ...ours] : ours;
    });
    const all = placed ? updated : [...updated, ...wanted(event)];
    if (all.length) next[event] = all;
  }
  for (const s of specs) if (!(s.event in hooks)) next[s.event] = wanted(s.event);
  return { ...settings, hooks: next };
}

/** The Attache-owned hooks currently in the settings. */
export function ourHooks(settings: Settings, isOurs: (command: string) => boolean): HookSpec[] {
  return Object.entries(hooksOf(settings)).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((g) =>
      (Array.isArray(g?.hooks) ? g.hooks : [])
        .filter((e) => typeof e?.command === "string" && isOurs(e.command))
        .map((e) => {
          const { type: _t, command, timeout, ...options } = e;
          return { event, ...(g.matcher !== undefined ? { matcher: g.matcher } : {}), command: command!, timeout: Number(timeout ?? 0), ...(Object.keys(options).length ? { options: options as HookSpec["options"] } : {}) };
        }),
    ),
  );
}

export function sameHooks(a: HookSpec[], b: HookSpec[]): boolean {
  const key = (s: HookSpec) => `${s.event}\u0000${s.matcher ?? ""}\u0000${s.command}\u0000${s.timeout}\u0000${JSON.stringify(Object.entries(s.options ?? {}).sort())}`;
  const ka = a.map(key).sort();
  const kb = b.map(key).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/** Read a JSON settings file. A missing file is an empty object; an unreadable one is an error, never overwritten. */
export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new HooksFileError(`${path} is not valid JSON (${(e as Error).message}); Attache will not change it.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HooksFileError(`${path} does not contain a JSON object; Attache will not change it.`);
  return parsed as Settings;
}

/** Back up the current file (if any) into `backupDir`, then replace it atomically. */
export function writeSettings(path: string, settings: Settings, backupDir: string): { backup: string | null } {
  return writeConfigText(path, JSON.stringify(settings, null, 2) + "\n", backupDir);
}

/** Back up a Harness configuration file (if it exists) into `backupDir`, then replace its text atomically. */
export function writeConfigText(path: string, text: string, backupDir: string): { backup: string | null } {
  let backup: string | null = null;
  if (existsSync(path)) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    backup = join(backupDir, `${path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+/, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}${extname(path) || ".bak"}`);
    copyFileSync(path, backup);
  }
  replaceFile(path, text);
  return { backup };
}

/**
 * Atomically replace a file in the user's home. A symlink (a dotfiles setup) is
 * followed so the link survives and the real file is updated, and the file's
 * permission bits are kept; new files are private to the user.
 */
export function replaceFile(path: string, content: string) {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${randomUUID()}.attache.tmp`);
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  replaceWith(tmp, target);
}

// ---- named format: { "<owner>": { enabled, Event: [{ type, command, timeout }] } } -------------

type Named = Record<string, unknown>;
/** Commands in one handler list: direct `{ command }` handlers, or `{ matcher, hooks: [...] }` groups for tool events. */
function handlerCommands(handlers: unknown[]): string[] {
  return handlers.flatMap((h) => {
    if (!h || typeof h !== "object") return [];
    if (typeof (h as HookEntry).command === "string") return [(h as HookEntry).command!];
    const nested = (h as HookGroup).hooks;
    return Array.isArray(nested) ? nested.flatMap((x) => (typeof x?.command === "string" ? [x.command] : [])) : [];
  });
}

function commandsOf(entry: unknown): string[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  return Object.values(entry as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? handlerCommands(v) : []));
}

/** Owner entries that consist only of Attache hooks (whatever key they were written under). */
function ourOwnerKeys(settings: Named, isOurs: (command: string) => boolean): string[] {
  return Object.entries(settings).filter(([, v]) => {
    const cmds = commandsOf(v);
    return cmds.length > 0 && cmds.every(isOurs);
  }).map(([k]) => k);
}

export function withoutNamedHooks(settings: Named, isOurs: (command: string) => boolean): Named {
  const drop = new Set(ourOwnerKeys(settings, isOurs));
  return Object.fromEntries(Object.entries(settings).filter(([k]) => !drop.has(k)));
}

export function withNamedHooks(settings: Named, owner: string, specs: HookSpec[], isOurs: (command: string) => boolean): Named {
  const base = withoutNamedHooks(settings, isOurs);
  if (owner in base) throw new HooksFileError(`The hooks file already has an entry named "${owner}" that Attache did not create; Attache will not change it.`);
  const entry: Record<string, unknown> = { enabled: true };
  for (const s of specs) entry[s.event] = [...((entry[s.event] as HookEntry[] | undefined) ?? []), { type: "command", command: s.command, timeout: s.timeout, ...s.options }];
  return { ...base, [owner]: entry };
}

export function ourNamedHooks(settings: Named, isOurs: (command: string) => boolean): HookSpec[] {
  return ourOwnerKeys(settings, isOurs).flatMap((k) =>
    Object.entries(settings[k] as Record<string, unknown>).flatMap(([event, v]) =>
      Array.isArray(v) ? v.filter((h): h is HookEntry => typeof (h as HookEntry)?.command === "string").map(({ type: _t, command, timeout, ...options }) => ({ event, command: command!, timeout: Number(timeout ?? 0), ...(Object.keys(options).length ? { options: options as HookSpec["options"] } : {}) })) : [],
    ),
  );
}
