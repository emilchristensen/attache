import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useResource } from "../live.ts";
import { Splitter, usePaneWidth, type PaneSize } from "../components/Splitter.tsx";
import { Inbox } from "./Inbox.tsx";
import { Chat } from "./Chat.tsx";

const CHAT_SIZE: PaneSize = { key: "jarvis.home.chatWidth", initial: 440, minRight: 320, minLeft: 360 };

export function Home() {
  const cfg = useResource<{ features: Record<string, boolean> }>("/config", ["config.changed"]);
  const f = cfg.data?.features ?? {};
  // On narrow screens one pane is shown at a time; wide screens show both side by side.
  const [pane, setPane] = useState<"inbox" | "chat">("inbox");
  const home = useRef<HTMLDivElement>(null);
  const [chatWidth, setChatWidth] = usePaneWidth(CHAT_SIZE);
  useEffect(() => {
    const show = () => setPane("chat");
    window.addEventListener("jarvis:focus-chat", show);
    return () => window.removeEventListener("jarvis:focus-chat", show);
  }, []);
  return (
    <div className="home" data-pane={pane} ref={home} style={{ "--chat-w": `${chatWidth}px` } as CSSProperties}>
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
      <Splitter container={home} size={CHAT_SIZE} width={chatWidth} onResize={setChatWidth} label="Resize conversation" controls="home-chat" />
      <section className="chat-col" id="home-chat" aria-label="Conversation">
        <Chat voiceOn={f.voice ?? false} />
      </section>
    </div>
  );
}
