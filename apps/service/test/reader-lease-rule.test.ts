import { describe, expect, it } from "vitest";
import { leaseToWrite, type LeaseContext } from "../src/reader/lease.ts";

const MAC = { id: "11111111-1111-4111-8111-111111111111", name: "Work Mac" };
const PC = { id: "22222222-2222-4222-8222-222222222222", name: "Home PC" };
const now = new Date("2026-11-11T12:00:00.000Z");

/** This Machine's view when nobody holds the lease yet, e.g. a Brain replicated before the lease existed. */
const unheld = (ctx: Partial<LeaseContext>) => leaseToWrite(null, { me: PC, preferredReader: null, standIn: false, founder: false, now, lastRefreshAt: null, ...ctx });

describe("who may take a Reader lease nobody holds", () => {
  it("not a Machine that is neither the Preferred Reader, a standby with its sources, nor the one that set up Replication", () => {
    expect(unheld({})).toBeNull();
  });

  it("the Preferred Reader", () => {
    expect(unheld({ preferredReader: PC.id })).toMatchObject({ holder: PC.id });
  });

  it("a standby Machine with its sources connected", () => {
    expect(unheld({ standIn: true })).toMatchObject({ holder: PC.id });
  });

  it("the Machine that set up Replication, while no Preferred Reader is chosen", () => {
    expect(unheld({ founder: true })).toMatchObject({ holder: PC.id });
  });

  it("not the Machine that set up Replication when the owner chose another Preferred Reader", () => {
    expect(unheld({ founder: true, preferredReader: MAC.id })).toBeNull();
  });
});
