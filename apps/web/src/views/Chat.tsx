import { useEffect, useMemo, useRef, useState } from "react";
import type { Citation, MessageView } from "@jarvis/contracts";
import { api, post } from "../api.ts";
import { useLiveEvent, useResource } from "../live.ts";
import { ErrorState, Link, Loading, renderMarkdown, Time, useToast } from "../components/ui.tsx";
import { useOpenEvidence } from "../components/Evidence.tsx";
import { useVoice, voice } from "../voice.ts";

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

const STATE_LABEL = { idle: "Ready", listening: "Listening", thinking: "Thinking", speaking: "Speaking", error: "Voice issue" } as const;

function withCitations(html: string, citations: Citation[]): string {
  const known = new Set(citations.map((c) => c.marker));
  return html.replace(/\[(S\d+)\]/g, (m, marker: string) => (known.has(marker) ? `<button type="button" class="cite" data-cite="${marker}" aria-label="Open source ${marker}">${marker}</button>` : m));
}

function AssistantMessage({ m, streamText, onRetry }: { m: MessageView; streamText: string | null; onRetry: () => void }) {
  const open = useOpenEvidence();
  const text = m.status === "streaming" ? (streamText ?? m.content) : m.content;
  const html = useMemo(() => withCitations(renderMarkdown(text || ""), m.citations), [text, m.citations]);
  const openCite = (c: Citation) => open({ root: c.root, relPath: c.relPath, lines: [c.startLine, c.endLine], title: c.title, marker: c.marker });
  return (
    <div className="msg assistant" data-message-id={m.id} data-status={m.status}>
      <div className="who">
        Jarvis
        {m.retrieval && <span>· {m.retrieval.hits} source{m.retrieval.hits === 1 ? "" : "s"} searched</span>}
        {m.model && <span>· {m.model.split(":").pop()}</span>}
        <Time iso={m.createdAt} />
      </div>
      {m.status === "streaming" && !text && <span className="muted small">{m.retrieval ? "Writing…" : "Searching your notes…"}</span>}
      <div
        className="body md"
        onClick={(e) => {
          const t = (e.target as HTMLElement).closest("[data-cite]") as HTMLElement | null;
          if (!t) return;
          const c = m.citations.find((x) => x.marker === t.dataset.cite);
          if (c) openCite(c);
        }}
      >
        <span dangerouslySetInnerHTML={{ __html: html }} />
        {m.status === "streaming" && text && <span className="caret" aria-hidden />}
      </div>
      {m.status === "complete" && m.retrieval && !m.retrieval.supported && m.retrieval.mode === "model" && (
        <div className="unsupported" role="note">
          No supporting evidence was cited from your notes. Treat this answer as unverified.
        </div>
      )}
      {m.status === "error" && (
        <div className="state error small" role="alert">
          <strong>The answer failed</strong>
          <span>{m.error}</span>
          <div className="row">
            <button className="small" onClick={onRetry}>
              Retry
            </button>
            <Link to="/connections">Check the model connection</Link>
          </div>
        </div>
      )}
      {m.status === "cancelled" && <span className="small muted">Stopped.</span>}
      {m.citations.length > 0 && m.status !== "streaming" && (
        <div className="sources" aria-label="Sources">
          {m.citations.map((c) => (
            <button key={c.marker} className="source-chip" onClick={() => openCite(c)} title={c.snippet}>
              <b>{c.marker}</b>
              <span>{c.title}</span>
              <span className="path">
                {c.relPath}:{c.startLine}
              </span>
              {c.section === "history" && <span className="pill warn">superseded</span>}
              {c.area !== "memory" && <span className="pill">{c.area}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Chat({ voiceOn, context }: { voiceOn: boolean; context?: { relPath: string; root: string } }) {
  const convs = useResource<Conversation[]>("/conversations", ["message.done"]);
  const [conversationId, setConversationId] = useState<string | null>(() => localStorage.getItem("jarvis.conversation"));
  const msgs = useResource<MessageView[]>(conversationId ? `/conversations/${conversationId}/messages` : null, []);
  const [stream, setStream] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(() => localStorage.getItem("jarvis.speakReplies") === "1");
  const pendingVoice = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const v = useVoice();
  const toast = useToast();

  useEffect(() => {
    if (conversationId) localStorage.setItem("jarvis.conversation", conversationId);
    else localStorage.removeItem("jarvis.conversation");
  }, [conversationId]);
  useEffect(() => localStorage.setItem("jarvis.speakReplies", speakReplies ? "1" : "0"), [speakReplies]);
  useEffect(() => {
    if (msgs.error?.status === 404) setConversationId(null);
  }, [msgs.error]);

  useLiveEvent((ev) => {
    if (ev.conversationId !== conversationId) return;
    if (ev.type === "message.delta") {
      const id = String(ev.messageId);
      setStream((s) => ({ ...s, [id]: (s[id] ?? "") + String(ev.delta) }));
      voice.setThinking(false);
    } else if (ev.type === "message.retrieval") msgs.reload();
    else if (ev.type === "message.done") {
      const m = ev.message as MessageView;
      msgs.reload();
      setStream((s) => {
        const { [m.id]: _drop, ...rest } = s;
        return rest;
      });
      voice.setThinking(false);
      if (pendingVoice.current === m.id && m.status === "complete" && voice.canSpeak && speakReplies) void voice.speak(m.content);
      pendingVoice.current = null;
    }
  });

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs.data?.length, stream]);

  const streamingId = msgs.data?.find((m) => m.status === "streaming")?.id ?? null;

  const send = async (t: string, viaVoice = false) => {
    const clean = t.trim();
    if (!clean || sending) return;
    setSending(true);
    try {
      const r = await post<{ conversationId: string; userMessage: MessageView; assistantMessage: MessageView }>("/chat", { conversationId, text: clean, ...(context ? { context } : {}) });
      if (r.conversationId !== conversationId) setConversationId(r.conversationId);
      msgs.setData([...(r.conversationId === conversationId ? (msgs.data ?? []) : []), r.userMessage, r.assistantMessage]);
      if (viaVoice) {
        pendingVoice.current = r.assistantMessage.id;
        voice.setThinking(true);
      }
      setText("");
      convs.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSending(false);
    }
  };

  const pttDown = async () => {
    voice.clearError();
    try {
      await voice.start();
    } catch {
      // state carries the recovery message
    }
  };
  const pttUp = async () => {
    const t = await voice.stop();
    if (t) await send(t, true);
  };
  voice.onBrowserTranscript = (t) => void send(t, true);

  return (
    <div className="chat">
      <div className="chat-head">
        <label className="sr-only" htmlFor="conv-select">
          Conversation
        </label>
        <select id="conv-select" value={conversationId ?? ""} onChange={(e) => setConversationId(e.target.value || null)}>
          <option value="">New conversation</option>
          {(convs.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button className="small ghost" onClick={() => setConversationId(null)}>
          New
        </button>
        <div style={{ flex: 1 }} />
        {voiceOn && (
          <>
            <span className="orb" data-state={v.state} aria-hidden />
            <span className="voice-label" aria-live="polite">
              {STATE_LABEL[v.state]}
            </span>
            {v.state === "speaking" && (
              <button className="small" onClick={() => voice.interrupt()}>
                Stop speaking
              </button>
            )}
          </>
        )}
      </div>
      <div className="messages" ref={listRef} aria-live="polite" aria-busy={!!streamingId}>
        {!conversationId && (
          <div className="state" style={{ marginTop: 20 }}>
            <strong style={{ color: "var(--text-2)" }}>Ask about your notes, people, projects and decisions</strong>
            <span className="small">Every answer searches your data folder first and cites what it used. Try “What did we decide about…?”</span>
          </div>
        )}
        {conversationId && msgs.loading && !msgs.data && <Loading lines={4} />}
        <ErrorState error={msgs.error?.status === 404 ? null : msgs.error} retry={msgs.reload} />
        {(msgs.data ?? []).map((m, i, all) =>
          m.role === "user" ? (
            <div key={m.id} className="msg user">
              {m.content}
            </div>
          ) : (
            <AssistantMessage key={m.id} m={m} streamText={stream[m.id] ?? null} onRetry={() => void send(all[i - 1]?.content ?? "")} />
          ),
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        {v.message && (
          <div className={v.state === "error" ? "unsupported" : "small muted"} role={v.state === "error" ? "alert" : "status"}>
            {v.message}
            {v.micDenied && (
              <button type="button" className="small" style={{ marginLeft: 8 }} onClick={() => void pttDown().then(() => voice.stop())}>
                Try the microphone again
              </button>
            )}
          </div>
        )}
        <div className="row">
          <label className="sr-only" htmlFor="composer">
            Message Jarvis
          </label>
          <textarea
            id="composer"
            rows={1}
            value={text}
            placeholder={context ? `Ask about ${context.relPath}…` : "Ask Jarvis…"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text);
              }
              if (e.key === "Escape") voice.interrupt();
            }}
          />
          {voiceOn && voice.canListen && (
            <button
              type="button"
              className={v.state === "listening" ? "danger" : ""}
              aria-pressed={v.state === "listening"}
              title="Hold to talk (or hold Space while this button is focused)"
              onPointerDown={(e) => {
                e.preventDefault();
                void pttDown();
              }}
              onPointerUp={() => void pttUp()}
              onPointerLeave={() => v.state === "listening" && void pttUp()}
              onKeyDown={(e) => {
                if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                  e.preventDefault();
                  void pttDown();
                }
              }}
              onKeyUp={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  void pttUp();
                }
              }}
            >
              {v.state === "listening" ? "Listening…" : "Hold to talk"}
            </button>
          )}
          {streamingId ? (
            <button type="button" onClick={() => void api(`/messages/${streamingId}/cancel`, { method: "POST", body: {} })}>
              Stop
            </button>
          ) : (
            <button className="primary" disabled={!text.trim() || sending}>
              Send
            </button>
          )}
        </div>
        <div className="row hint">
          <span>Enter to send · Shift+Enter for a new line · / to focus</span>
          {voiceOn && voice.canSpeak && (
            <label className="check" style={{ marginLeft: "auto" }}>
              <input type="checkbox" checked={speakReplies} onChange={(e) => setSpeakReplies(e.target.checked)} /> Speak replies to voice questions
            </label>
          )}
        </div>
      </form>
    </div>
  );
}
