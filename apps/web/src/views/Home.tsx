import { useResource } from "../live.ts";
import { Inbox } from "./Inbox.tsx";
import { Chat } from "./Chat.tsx";

export function Home() {
  const cfg = useResource<{ features: Record<string, boolean> }>("/config", ["config.changed"]);
  const f = cfg.data?.features ?? {};
  return (
    <div className="home">
      <section className="inbox-col" aria-label="Attention inbox">
        <Inbox attentionOn={f.attention ?? false} draftsOn={f.drafts ?? false} />
      </section>
      <section className="chat-col" aria-label="Conversation">
        <Chat voiceOn={f.voice ?? false} />
      </section>
    </div>
  );
}
