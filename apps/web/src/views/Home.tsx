import { useEffect, useState } from "react";
import { useResource } from "../live.ts";
import { Inbox } from "./Inbox.tsx";
import { Chat } from "./Chat.tsx";

export function Home() {
  const cfg = useResource<{ features: Record<string, boolean> }>("/config", ["config.changed"]);
  const f = cfg.data?.features ?? {};
  // On narrow screens one pane is shown at a time; wide screens show both side by side.
  const [pane, setPane] = useState<"inbox" | "chat">("inbox");
  useEffect(() => {
    const show = () => setPane("chat");
    window.addEventListener("jarvis:focus-chat", show);
    return () => window.removeEventListener("jarvis:focus-chat", show);
  }, []);
  return (
    <div className="home" data-pane={pane}>
      <div className="home-switch" role="group" aria-label="Show">
        <button aria-pressed={pane === "inbox"} onClick={() => setPane("inbox")}>
          Inbox
        </button>
        <button aria-pressed={pane === "chat"} onClick={() => setPane("chat")}>
          Conversation
        </button>
      </div>
      <section className="inbox-col" aria-label="Attention inbox">
        <Inbox attentionOn={f.attention ?? false} draftsOn={f.drafts ?? false} />
      </section>
      <section className="chat-col" aria-label="Conversation">
        <Chat voiceOn={f.voice ?? false} />
      </section>
    </div>
  );
}
