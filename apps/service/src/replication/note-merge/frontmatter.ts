import { stringify as stringifyYaml } from "yaml";
import type { NoteParts } from "./parts.ts";
import { compareMachines, compareText, type Side } from "./sides.ts";

type Fields = Readonly<Record<string, unknown>>;

/** A value as text with object keys sorted, so equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => compareText(a, b))) : v,
  ) ?? "undefined";
}

const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);

function union(a: readonly unknown[], b: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((v) => {
    const key = canonical(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

/** A field both sides changed: dates take the earliest creation and the latest update, lists keep both. */
function both(key: string, a: unknown, b: unknown, newer: unknown): unknown {
  if (a === undefined || b === undefined) return a ?? b;
  if (key === "created") return compareText(day(a), day(b)) <= 0 ? a : b;
  if (key === "updated") return compareText(day(a), day(b)) >= 0 ? a : b;
  if (Array.isArray(a) && Array.isArray(b)) return union(a, b);
  return newer;
}

/** The side whose note was updated last; the same date goes to the Machine that sorts last. */
function newerSide(first: Side<Fields>, second: Side<Fields>): Fields {
  const byUpdated = compareText(day(first.value.updated ?? ""), day(second.value.updated ?? ""));
  return (byUpdated || compareMachines(first.machine, second.machine)) > 0 ? first.value : second.value;
}

/**
 * Merges frontmatter field by field. A field only one side changed takes that
 * change. When both changed one, `created` keeps the earliest, `updated` the
 * latest, lists keep every item once, and any other field takes the value from
 * the note that was updated last.
 */
export function mergeFrontmatter(base: NoteParts, first: Side<NoteParts>, second: Side<NoteParts>): string | null {
  if (first.value.frontmatter === null && second.value.frontmatter === null) return null;
  const b: Fields = base.frontmatter ?? {};
  const f: Fields = first.value.frontmatter ?? {};
  const s: Fields = second.value.frontmatter ?? {};
  const newer = newerSide({ value: f, machine: first.machine }, { value: s, machine: second.machine });
  const keys = [...new Set([...Object.keys(f), ...Object.keys(s)])];
  const merged = Object.fromEntries(
    keys
      .map((k): [string, unknown] => {
        if (equal(f[k], s[k]) || equal(s[k], b[k])) return [k, f[k]];
        if (equal(f[k], b[k])) return [k, s[k]];
        return [k, both(k, f[k], s[k], newer[k])];
      })
      .filter(([, v]) => v !== undefined),
  );
  if (first.value.frontmatter && equal(merged, first.value.frontmatter)) return first.value.frontmatterText;
  if (second.value.frontmatter && equal(merged, second.value.frontmatter)) return second.value.frontmatterText;
  return stringifyYaml(merged, { lineWidth: 0 }).trimEnd();
}
