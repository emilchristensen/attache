import type { MouseEvent, ReactNode } from "react";
import type { BriefingView } from "@attache/contracts";
import { entryTarget, leadWords, type EntryTarget } from "../briefing-area.ts";
import { useHomeClock } from "../heads-up-clock.ts";
import { openOnHome } from "../inbox-place.ts";
import { paintingForDate } from "../paintings.ts";
import { draftHref, proposalHref } from "../routes.ts";
import { clockTime, dayKey } from "../zoned-time.ts";
import { Icon } from "../components/icons.tsx";
import { Link, Loading, navigate } from "../components/ui.tsx";
import { BriefingPainting } from "./BriefingPainting.tsx";
import { BriefingSummary } from "./BriefingParts.tsx";
import { useBriefings } from "./briefings.ts";
import { YourDay } from "./YourDay.tsx";

type Item = BriefingView["sections"][number]["items"][number];

const HREF: Readonly<Record<EntryTarget["kind"], (id: string) => string>> = { draft: draftHref, proposal: proposalHref, inbox: () => "/" };

/** One entry: its words open the Inbox item, Draft or Proposal it comes from; its source opens in a new tab. */
function Entry({ briefing, itemId, headline, text, url }: { briefing: BriefingView; itemId: string; headline: string; text: string; url: string | null }) {
  const target = entryTarget(briefing, itemId);
  const href = HREF[target.kind](target.id);
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (target.kind === "inbox") openOnHome(target.id);
    navigate(href);
  };
  return (
    <li className="briefing-item" data-briefing-entry={target.kind}>
      <a className="briefing-item-title" href={href} onClick={open}>
        <strong>{headline}</strong>
      </a>
      {text && <span>{text}</span>}
      {url && (
        <a className="briefing-item-source" href={url} target="_blank" rel="noopener noreferrer">
          Open the source
          <Icon name="external" size={13} />
        </a>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="briefing-page-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/**
 * Read briefing: the whole briefing as a page under Home ("Home / The Daily Briefing"): the painting, First on your
 * list, Top to-dos as they were when it was written, New updates and Your day, live from the agenda route (the
 * briefing keeps no copy of the schedule). Every entry leads to what it comes from.
 */
export function BriefingPage({ id }: { id: string }) {
  const briefings = useBriefings();
  const clock = useHomeClock();
  const briefing = [briefings.data?.daily, briefings.data?.requested].find((b) => b?.id === id) ?? null;
  if (!briefing)
    return (
      <section className="page briefing-page">
        {briefings.loading && !briefings.data ? (
          <Loading label="Loading the briefing" />
        ) : (
          <p>
            {briefings.error ? "Could not read the briefing." : "This briefing is no longer the latest one."} <Link to="/">Back to Home</Link>
          </p>
        )}
      </section>
    );
  const items = new Map<string, Item>(briefing.sections.flatMap((s) => s.items).map((i) => [i.id, i]));
  const painting = paintingForDate(dayKey(Date.parse(briefing.createdAt), clock.timeZone));
  const lead = leadWords(briefing);
  const picks = briefing.topPicks.flatMap((pick) => items.get(pick) ?? []);
  return (
    <section className="page briefing-page" aria-label="The Daily Briefing">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link to="/">Home</Link>
        <span aria-hidden>/</span>
        <span aria-current="page">The Daily Briefing</span>
      </nav>
      <BriefingPainting painting={painting} className="briefing-page-hero">
        <p className="briefing-page-written">Written {clockTime(Date.parse(briefing.createdAt), clock.timeZone)}</p>
        <h1>
          <span className="briefing-painting-the">The</span> Daily Briefing
        </h1>
      </BriefingPainting>
      <Section title="First on your list">
        <ul className="briefing-items">
          {briefing.lead ? <Entry briefing={briefing} itemId={briefing.lead.itemId} headline={lead.headline} text={lead.explanation} url={items.get(briefing.lead.itemId)?.url ?? null} /> : <li className="briefing-item">{lead.headline}</li>}
        </ul>
        <BriefingSummary briefing={briefing} />
      </Section>
      <Section title="Top to-dos">
        {picks.length ? (
          <ul className="briefing-items">
            {picks.map((item) => (
              <Entry key={item.id} briefing={briefing} itemId={item.id} headline={item.title} text={item.summary} url={item.url} />
            ))}
          </ul>
        ) : (
          <p>Nothing was open when this briefing was written.</p>
        )}
      </Section>
      <Section title="New updates">
        {briefing.updates.length ? (
          <ul className="briefing-items">
            {briefing.updates.map((u) => (
              <Entry key={u.itemId} briefing={briefing} itemId={u.itemId} headline={u.headline} text={u.text} url={items.get(u.itemId)?.url ?? null} />
            ))}
          </ul>
        ) : (
          <p>No new updates.</p>
        )}
      </Section>
      <YourDay clock={clock} enabled />
    </section>
  );
}
