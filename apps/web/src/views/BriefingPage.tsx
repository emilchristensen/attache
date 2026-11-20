import type { BriefingView } from "@attache/contracts";
import { useResource } from "../live.ts";
import { Link, useLocation } from "../components/ui.tsx";
import { useHomeClock } from "../heads-up-clock.ts";
import { paintingForDate } from "../paintings.ts";
import { clockTime } from "../zoned-time.ts";

function itemHref(item: BriefingView["sections"][number]["items"][number]) {
  return item.url ?? `/`;
}

export function BriefingPage() {
  const path = useLocation().path;
  const id = decodeURIComponent(path.slice("/briefing/".length));
  const resource = useResource<{ daily: BriefingView | null; requested: BriefingView | null }>("/briefings", ["briefing.created"]);
  const clock = useHomeClock();
  const briefing = [resource.data?.daily, resource.data?.requested].find((value) => value?.id === id) ?? null;
  if (!briefing) return <section className="page"><p>Could not find this briefing.</p><Link to="/">Back to Home</Link></section>;
  const items = new Map(briefing.sections.flatMap((section) => section.items).map((item) => [item.id, item]));
  const painting = paintingForDate(new Date(briefing.createdAt).toLocaleDateString("en-CA", { timeZone: clock.timeZone }));
  return <section className="page briefing-page">
    <nav className="breadcrumbs"><Link to="/">Home</Link><span>/</span><strong>The Daily Briefing</strong></nav>
    <header className="briefing-page-hero" style={{ backgroundImage: `url(${painting.src})`, backgroundPosition: painting.focal }}><div><p>Written {clockTime(Date.parse(briefing.createdAt), clock.timeZone)}</p><h1>The Daily Briefing</h1><small>{painting.title} · {painting.painter}</small></div></header>
    <section><h2>First on your list</h2>{briefing.lead && <a className="briefing-item" href={itemHref(items.get(briefing.lead.itemId)!)}><strong>{briefing.lead.headline}</strong><span>{briefing.lead.explanation}</span></a>}</section>
    <section><h2>Top to-dos</h2>{briefing.topPicks.map((itemId) => { const item = items.get(itemId); return item && <a className="briefing-item" href={itemHref(item)} key={itemId}><strong>{item.title}</strong><span>{item.summary}</span></a>; })}</section>
    <section><h2>New updates</h2>{briefing.updates.length ? briefing.updates.map((update) => { const item = items.get(update.itemId); return item && <a className="briefing-item" href={itemHref(item)} key={`${update.itemId}:${update.headline}`}><strong>{update.headline}</strong><span>{update.text}</span></a>; }) : <p>No new updates.</p>}</section>
    <section><h2>Your day</h2><p>Open the agenda from the items above to see the day as it stands now.</p>{briefing.sections.filter((section) => section.id === "meetings").flatMap((section) => section.items).map((item) => <a className="briefing-item" href={itemHref(item)} key={item.id}><strong>{item.title}</strong><span>{item.summary}</span></a>)}</section>
  </section>;
}
