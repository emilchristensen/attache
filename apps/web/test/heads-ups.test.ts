import { describe, expect, it } from "vitest";
import { forYouNow, HEADS_UP_KINDS, RANK, VISIBLE_FOLLOWERS, type BriefingView, type HeadsUp, type HeadsUpInput, type HeadsUpKind } from "../src/heads-ups.ts";

const CPH = "Europe/Copenhagen";

/** A briefing as `GET /briefings/latest` returns it. */
function briefing(over: Partial<BriefingView> = {}): BriefingView {
  return {
    id: "b1",
    kind: "daily",
    createdAt: "2026-11-18T07:02:00Z", // 08:02 in Copenhagen
    since: null,
    summary: "Nora confirmed the pilot window. The invoice fallback still needs your review. A reply to Nora is ready.",
    sections: [],
    counts: { open: 4, new: 1, changed: 0, drafts: 1, proposals: 0, failedSources: 0 },
    deliverablePath: "deliverables/briefings/2026-11-18.md",
    ...over,
  };
}

function input(at: string, over: Partial<HeadsUpInput> = {}): HeadsUpInput {
  return { now: Date.parse(at), timeZone: CPH, briefing: briefing(), briefingJob: null, settled: new Set(), schedule: { briefingAt: "08:00", briefingEnabled: true }, ...over };
}

describe("the daily briefing", () => {
  it("leads from when it is written until local noon", () => {
    const slot = forYouNow(input("2026-11-18T09:30:00Z")); // 10:30 in Copenhagen
    expect(slot.lead).toMatchObject({ key: "briefing:b1", kind: "daily-briefing", label: "Morning briefing", timing: "Until noon", title: "Nora confirmed the pilot window.", explanation: "The invoice fallback still needs your review." });
    expect(slot.followers).toEqual([]);
    expect(slot.quiet).toBeNull();
  });
});

describe("the daily briefing after noon or Got it", () => {
  it("shrinks to an Earlier today line at noon", () => {
    const slot = forYouNow(input("2026-11-18T11:00:00Z")); // 12:00 in Copenhagen
    expect(slot.lead).toBeNull();
    expect(slot.followers).toMatchObject([{ key: "earlier:b1", kind: "earlier-today", form: "line", label: "Daily briefing", timing: "Earlier today, 08:02" }]);
    expect(slot.followers[0]!.why).toBe("Written at 08:02. It stays here until midnight while it is the latest briefing.");
  });

  it("still leads one minute before noon", () => {
    expect(forYouNow(input("2026-11-18T10:59:00Z")).lead?.kind).toBe("daily-briefing");
  });

  it("shrinks to the Earlier today line on Got it, before noon", () => {
    const slot = forYouNow(input("2026-11-18T08:00:00Z", { settled: new Set(["briefing:b1"]) }));
    expect(slot.lead).toBeNull();
    expect(slot.followers.map((h) => h.kind)).toEqual(["earlier-today"]);
  });

  it("leaves at midnight", () => {
    expect(forYouNow(input("2026-11-18T22:59:00Z")).followers.map((h) => h.kind)).toEqual(["earlier-today"]);
    const next = forYouNow(input("2026-11-18T23:00:00Z")); // 00:00 on the 19th in Copenhagen
    expect(next.lead).toBeNull();
    expect(next.followers).toEqual([]);
  });

  it("never shows yesterday's briefing as today's", () => {
    const slot = forYouNow(input("2026-11-19T07:30:00Z")); // 08:30 the next morning, before the new one is written
    expect(slot.lead).toBeNull();
    expect(slot.followers).toEqual([]);
  });

  it("goes straight to the Earlier today line when it is written after noon", () => {
    const late = briefing({ createdAt: "2026-11-18T13:15:00Z" }); // 14:15 in Copenhagen, a catch-up
    const slot = forYouNow(input("2026-11-18T13:20:00Z", { briefing: late }));
    expect(slot.lead).toBeNull();
    expect(slot.followers.map((h) => [h.kind, h.timing])).toEqual([["earlier-today", "Earlier today, 14:15"]]);
  });
});

describe("a time zone change", () => {
  it("counts noon and the day in the zone the browser is in now", () => {
    // Written 08:02 in Copenhagen = 02:02 in New York. At 10:30 Copenhagen time it is 04:30 in New York.
    const there = forYouNow(input("2026-11-18T09:30:00Z", { timeZone: "America/New_York" }));
    expect(there.lead).toMatchObject({ kind: "daily-briefing", why: "Written at 02:02 for this morning. It leaves at noon, or when you press Got it." });
    // At 12:30 Copenhagen time the Copenhagen noon has passed, but in New York it is 06:30: still the morning there.
    expect(forYouNow(input("2026-11-18T11:30:00Z", { timeZone: "America/New_York" })).lead?.kind).toBe("daily-briefing");
    // New York's noon is 17:00 UTC.
    expect(forYouNow(input("2026-11-18T17:00:00Z", { timeZone: "America/New_York" })).followers.map((h) => h.kind)).toEqual(["earlier-today"]);
  });

  it("moves the briefing to the day it falls on in the new zone", () => {
    // Written 08:02 in Copenhagen on the 18th = 18:02 on the 18th in Sydney. Flying on: at 09:00 Sydney on the 19th, it is yesterday's.
    const slot = forYouNow(input("2026-11-18T22:00:00Z", { timeZone: "Australia/Sydney" }));
    expect(slot.lead).toBeNull();
    expect(slot.followers).toEqual([]);
  });

  it("finds noon across a daylight-saving change", () => {
    // Copenhagen leaves summer time at 03:00 on 25 October 2026; that day's noon is 11:00 UTC, not 10:00.
    const autumn = briefing({ createdAt: "2026-10-25T06:00:00Z" });
    expect(forYouNow(input("2026-10-25T10:30:00Z", { briefing: autumn })).lead?.kind).toBe("daily-briefing");
    expect(forYouNow(input("2026-10-25T11:00:00Z", { briefing: autumn })).lead).toBeNull();
  });
});

describe("an away summary and a briefing the owner asked for", () => {
  const away = briefing({ id: "a1", kind: "away", createdAt: "2026-11-18T13:10:00Z", since: "2026-11-15T13:10:00Z" }); // 14:10 in Copenhagen
  const asked = briefing({ id: "m1", kind: "manual", createdAt: "2026-11-18T13:10:00Z" });

  it("leads for four hours from when it was made", () => {
    expect(forYouNow(input("2026-11-18T13:10:00Z", { briefing: away })).lead).toMatchObject({ key: "briefing:a1", kind: "away-summary", label: "Away summary", timing: "Until 18:10", why: "You asked for it at 14:10. It leaves at 18:10, or when you press Got it.", actions: ["read-briefing", "got-it"] });
    expect(forYouNow(input("2026-11-18T17:09:00Z", { briefing: asked })).lead).toMatchObject({ key: "briefing:m1", kind: "requested-briefing", label: "Briefing you asked for", timing: "Until 18:10" });
  });

  it("leaves after four hours, with no line after it", () => {
    for (const b of [away, asked]) {
      const slot = forYouNow(input("2026-11-18T17:10:00Z", { briefing: b }));
      expect(slot.lead).toBeNull();
      expect(slot.followers).toEqual([]);
    }
  });

  it("leaves on Got it", () => {
    expect(forYouNow(input("2026-11-18T14:00:00Z", { briefing: away, settled: new Set(["briefing:a1"]) })).lead).toBeNull();
  });

  it("says which day it was made when that was not today", () => {
    const lateNight = briefing({ id: "m2", kind: "manual", createdAt: "2026-11-18T22:30:00Z" }); // 23:30 in Copenhagen
    expect(forYouNow(input("2026-11-18T23:30:00Z", { briefing: lateNight })).lead).toMatchObject({ timing: "Until 03:30", why: "You asked for it yesterday at 23:30. It leaves at 03:30, or when you press Got it." });
  });

  it("is never the daily briefing's Earlier today line", () => {
    expect(forYouNow(input("2026-11-18T20:00:00Z", { briefing: away })).followers).toEqual([]);
  });
});

describe("briefing progress", () => {
  it("is a line while a briefing job runs, under the briefing", () => {
    const slot = forYouNow(input("2026-11-18T09:30:00Z", { briefingJob: { id: "j1", progress: 0.4, note: "Composing briefing" } }));
    expect(slot.lead?.kind).toBe("daily-briefing");
    expect(slot.followers).toMatchObject([{ key: "progress:j1", kind: "briefing-progress", form: "line", label: "Preparing a briefing", timing: "40%", title: "Composing briefing", why: "Here while the briefing is written. It keeps running if you close this tab." }]);
  });

  it("says Queued before the job reports", () => {
    expect(forYouNow(input("2026-11-18T09:30:00Z", { briefing: null, briefingJob: { id: "j1", progress: 0, note: null } })).followers[0]).toMatchObject({ title: "Queued", timing: "0%" });
  });
});

/** A stand-in kind, as meeting prep will be: one card per meeting, ranked before briefings. */
function meetings(...starts: Array<[key: string, start: string]>): HeadsUpKind {
  return {
    id: "daily-briefing",
    applies: () =>
      starts.map(([key, start]): HeadsUp => ({ key, kind: "daily-briefing", form: "card", rank: RANK.meeting, at: Date.parse(start), label: "Meeting prep", timing: "", title: key, explanation: null, why: "", actions: [], until: null })),
  };
}

describe("the slot", () => {
  it("orders by urgency, then time, then key, with one lead and the rest as followers", () => {
    const kinds = [...HEADS_UP_KINDS, meetings(["m:b", "2026-11-18T09:30:00Z"], ["m:a", "2026-11-18T09:30:00Z"], ["m:early", "2026-11-18T09:00:00Z"])];
    const slot = forYouNow(input("2026-11-18T09:20:00Z", { briefingJob: { id: "j1", progress: 0.5, note: null } }), kinds);
    expect(slot.lead?.key).toBe("m:early");
    expect(VISIBLE_FOLLOWERS).toBe(2);
    expect(slot.followers.map((h) => h.key)).toEqual(["m:a", "m:b"]);
    expect(slot.more.map((h) => h.key)).toEqual(["briefing:b1", "progress:j1"]);
  });

  it("has no lead when the most urgent entry is a line", () => {
    const slot = forYouNow(input("2026-11-18T13:00:00Z", { briefingJob: { id: "j1", progress: 0.5, note: null } }));
    expect(slot.lead).toBeNull();
    expect(slot.followers.map((h) => h.kind)).toEqual(["briefing-progress", "earlier-today"]);
  });

  it("gives every Heads-up a why line", () => {
    const cases = [input("2026-11-18T09:30:00Z"), input("2026-11-18T13:00:00Z"), input("2026-11-18T13:10:00Z", { briefing: briefing({ kind: "away", createdAt: "2026-11-18T13:00:00Z" }) }), input("2026-11-18T13:10:00Z", { briefing: briefing({ kind: "manual", createdAt: "2026-11-18T13:00:00Z" }), briefingJob: { id: "j", progress: 0, note: null } })];
    const shown = cases.flatMap((c) => {
      const s = forYouNow(c);
      return [...(s.lead ? [s.lead] : []), ...s.followers, ...s.more];
    });
    expect(new Set(shown.map((h) => h.kind))).toEqual(new Set(["daily-briefing", "earlier-today", "away-summary", "requested-briefing", "briefing-progress"]));
    for (const h of shown) expect(h.why.length).toBeGreaterThan(20);
  });
});

describe("the quiet line", () => {
  it("says nothing is timely and when the next daily briefing is due", () => {
    expect(forYouNow(input("2026-11-19T05:00:00Z", { briefing: null })).quiet).toBe("Nothing timely right now. The daily briefing is scheduled for 08:00.");
    // Yesterday's briefing is the latest, but its day is over.
    expect(forYouNow(input("2026-11-19T05:00:00Z")).quiet).toBe("Nothing timely right now. The daily briefing is scheduled for 08:00.");
  });

  it("says tomorrow once today's briefing time has passed or today's briefing is written", () => {
    expect(forYouNow(input("2026-11-18T21:30:00Z", { briefing: null })).quiet).toBe("Nothing timely right now. The next daily briefing is scheduled for 08:00 tomorrow.");
    const away = briefing({ kind: "away", createdAt: "2026-11-18T05:00:00Z" });
    expect(forYouNow(input("2026-11-18T10:00:00Z", { briefing: away })).quiet).toBe("Nothing timely right now. The next daily briefing is scheduled for 08:00 tomorrow.");
  });

  it("says when daily briefings are off, and makes no promise while the schedule is not known", () => {
    expect(forYouNow(input("2026-11-19T05:00:00Z", { briefing: null, schedule: { briefingAt: "08:00", briefingEnabled: false } })).quiet).toBe("Nothing timely right now. The daily briefing is switched off.");
    expect(forYouNow(input("2026-11-19T05:00:00Z", { briefing: null, schedule: null })).quiet).toBe("Nothing timely right now.");
  });

  it("is not shown while the briefing is not known, so it never claims nothing is timely", () => {
    const slot = forYouNow(input("2026-11-19T05:00:00Z", { briefing: "unknown" }));
    expect(slot).toEqual({ lead: null, followers: [], more: [], quiet: null });
  });
});
