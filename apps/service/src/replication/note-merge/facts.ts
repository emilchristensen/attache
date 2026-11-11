import { formerValueLine } from "../../memory/markdown.ts";
import type { MachineRef } from "../seams.ts";
import type { FactBlock, HistoryItem } from "./parts.ts";
import { compareMachines, compareText, type Side } from "./sides.ts";

export interface MergedFacts {
  readonly facts: readonly FactBlock[];
  /** History lines for the values that lost, each naming the Machine it came from. */
  readonly superseded: readonly HistoryItem[];
}

type Facts = readonly FactBlock[];

const same = (a: FactBlock | undefined, b: FactBlock | undefined) => (a && b ? a.lines.join("\n") === b.lines.join("\n") : a === b);

const byKey = (facts: Facts) => new Map(facts.map((f) => [f.key, f]));

interface Candidate {
  readonly fact: FactBlock;
  readonly machine: MachineRef;
}

/** The newer date wins; on the same date the Machine that sorts last wins, the same on every Machine. */
function newer(a: Candidate, b: Candidate): { winner: Candidate; loser: Candidate; tie: boolean } {
  const byDate = compareText(a.fact.entry.date, b.fact.entry.date);
  const order = byDate || compareMachines(a.machine, b.machine) || compareText(a.fact.lines.join("\n"), b.fact.lines.join("\n"));
  return order >= 0 ? { winner: a, loser: b, tie: byDate === 0 } : { winner: b, loser: a, tie: byDate === 0 };
}

function supersededLine(winner: Candidate, loser: Candidate, tie: boolean): HistoryItem {
  const why = tie
    ? `both Machines changed it on ${winner.fact.entry.date}; Replication kept the value from ${winner.machine.name}, as every Machine does for the same date, and this value came from ${loser.machine.name}`
    : `Replication kept the newer value from ${winner.machine.name}; this value came from ${loser.machine.name}`;
  return [formerValueLine(winner.fact.entry.date, loser.fact.entry, "superseded", why)];
}

/**
 * Merges Current State by subject. A subject only one side changed takes that
 * change; when both changed it, the newer date wins and the other value goes
 * to History naming its Machine. A change wins over a removal, so no value is
 * lost. A fact keeps its whole entry, Review date and source included.
 */
export function mergeFacts(base: Facts, first: Side<Facts>, second: Side<Facts>): MergedFacts {
  const b = byKey(base);
  const f = byKey(first.value);
  const s = byKey(second.value);
  const superseded: HistoryItem[] = [];
  const pick = (key: string): FactBlock | undefined => {
    const [bf, ff, sf] = [b.get(key), f.get(key), s.get(key)];
    if (same(ff, sf) || same(sf, bf)) return ff;
    if (same(ff, bf)) return sf;
    if (!ff || !sf) return ff ?? sf;
    const { winner, loser, tie } = newer({ fact: ff, machine: first.machine }, { fact: sf, machine: second.machine });
    superseded.push(supersededLine(winner, loser, tie));
    return winner.fact;
  };
  const keys = [...new Set([...first.value, ...second.value].map((x) => x.key))];
  const facts = keys.map(pick).filter((x): x is FactBlock => x !== undefined);
  return { facts, superseded };
}
