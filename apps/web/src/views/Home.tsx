import { useResource } from "../live.ts";
import { Inbox } from "./Inbox.tsx";

/** Home is the attention inbox. Questions to the Brain happen in the owner's Harness (ADR 0003). */
export function Home() {
  const cfg = useResource<{ features: Record<string, boolean> }>("/config", ["config.changed"]);
  const f = cfg.data?.features ?? {};
  return (
    <section className="page page-inbox" aria-label="Attention inbox">
      <Inbox attentionOn={f.attention ?? false} draftsOn={f.drafts ?? false} />
    </section>
  );
}
