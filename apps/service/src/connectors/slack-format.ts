/**
 * Parsers for the claude.ai Slack connector's results. Its tools return JSON
 * whose values are Markdown-like text blocks; everything here is pure and
 * strict: a block that cannot be read is counted, never silently dropped.
 */

export interface SlackItem {
  channel: string;
  channelName: string | null;
  isDm: boolean;
  user: string | null;
  userName: string | null;
  bot: boolean;
  ts: string;
  threadTs: string | null;
  permalink: string | null;
  text: string;
}

export interface Parsed<T> {
  items: T[];
  unreadable: number;
  cursor: string | null;
}

const TS = /^\d{9,11}\.\d{1,6}$/;
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/;

/** The tool result is JSON with a text field; anything else is passed through as text. */
export function field(raw: string, key: string): string {
  try {
    const v = (JSON.parse(raw) as Record<string, unknown>)[key];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/** "…use cursor `abc=`" → "abc=". */
export function cursorFrom(raw: string): string | null {
  const info = field(raw, "pagination_info");
  const m = /cursor:?\s*`([^`]+)`/i.exec(info);
  return m ? m[1]! : null;
}

function threadTsFrom(permalink: string | null): string | null {
  if (!permalink) return null;
  try {
    const t = new URL(permalink).searchParams.get("thread_ts");
    return t && TS.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** "Ada Lovelace <ada@example.com> (ID: U03…)  [BOT]" → parts. */
function person(line: string): { user: string | null; name: string | null; bot: boolean } {
  const idPattern = /\((?:ID:\s*)?([UWB][A-Z0-9]{3,})\)/;
  const id = idPattern.exec(line)?.[1] ?? null;
  const name = line.replace(idPattern, "").replace(/<[^>]*>/, "").replace(/\[BOT\]/i, "").replace(/\s+/g, " ").trim() || null;
  return { user: id, name, bot: /\[BOT\]/i.test(line) || (id?.startsWith("B") ?? false) };
}

/** Parse slack_search_public_and_private results. */
export function parseSearch(raw: string): Parsed<SlackItem> {
  const md = field(raw, "results");
  const items: SlackItem[] = [];
  let unreadable = 0;
  const blocks = md.split(/^### Result \d+ of \d+\s*$/m).slice(1);
  for (const block of blocks) {
    const body = block.split(/^---\s*$/m)[0] ?? "";
    const line = (label: string) => new RegExp(`^${label}:[ \\t]*(.*)$`, "m").exec(body)?.[1]?.trim() ?? null;
    const channelLine = line("Channel") ?? "";
    const channel = /\(ID:\s*([A-Z0-9]+)\)/.exec(channelLine)?.[1] ?? "";
    const ts = line("Message_ts") ?? "";
    const from = person(line("From") ?? "");
    const permalink = /\]\((https?:\/\/[^)\s]+)\)/.exec(line("Permalink") ?? "")?.[1] ?? null;
    const textMatch = /^Text:[ \t]*\n?([\s\S]*)$/m.exec(body);
    if (!CHANNEL_ID.test(channel) || !TS.test(ts)) {
      unreadable++;
      continue;
    }
    const name = /^#(\S+)/.exec(channelLine)?.[1] ?? null;
    items.push({
      channel,
      channelName: name,
      isDm: /^DM\b/.test(channelLine) || channel.startsWith("D"),
      user: from.user,
      userName: from.name,
      bot: from.bot,
      ts,
      threadTs: threadTsFrom(permalink),
      permalink,
      text: (textMatch?.[1] ?? "").trim(),
    });
  }
  return { items, unreadable, cursor: cursorFrom(raw) };
}

/** Parse slack_read_channel / slack_read_thread results. */
export function parseHistory(raw: string, channel: string): Parsed<SlackItem> {
  const md = field(raw, "messages");
  const items: SlackItem[] = [];
  let unreadable = 0;
  const header = /^Channel:\s*(.*)$/m.exec(md)?.[1] ?? "";
  const channelName = /^#(\S+)/.exec(header)?.[1] ?? null;
  const parts = md.split(/^=== Message from /m).slice(1);
  for (const part of parts) {
    const [head = "", ...rest] = part.split("\n");
    const who = head.replace(/\s+at\s+\d{4}-\d{2}-\d{2}.*$/, "").replace(/===\s*$/, "");
    const from = person(who);
    const body = rest.join("\n");
    const ts = /^Message TS:\s*(\S+)/m.exec(body)?.[1] ?? "";
    if (!TS.test(ts)) {
      unreadable++;
      continue;
    }
    const text = body
      .replace(/^Message TS:.*$/m, "")
      .replace(/^(Reactions|Thread|Replies|Reply count|Files?):.*$/gm, "")
      .trim();
    const threadTs = /^Thread TS:\s*(\S+)/m.exec(body)?.[1] ?? null;
    items.push({ channel, channelName, isDm: channel.startsWith("D"), user: from.user, userName: from.name, bot: from.bot, ts, threadTs: threadTs && TS.test(threadTs) ? threadTs : null, permalink: null, text });
  }
  return { items, unreadable, cursor: cursorFrom(raw) };
}

/** "User ID: U03…" from slack_read_user_profile (detailed). */
export function parseProfile(raw: string): { userId: string | null; name: string | null; email: string | null } {
  const text = field(raw, "result") || raw;
  const get = (label: string) => new RegExp(`^${label}:[ \\t]*(.+)$`, "m").exec(text)?.[1]?.trim() ?? null;
  const userId = get("User ID");
  return { userId: userId && /^[UW][A-Z0-9]+$/.test(userId) ? userId : null, name: get("Real Name") ?? get("Display Name"), email: get("Email") };
}

/** The message ts a send reported, from a ts field or a permalink (".../p1790779742146499"). */
export function sentTs(raw: string): { ts: string | null; permalink: string | null } {
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // text result
  }
  const direct = [obj.ts, obj.message_ts, (obj.message as { ts?: unknown } | undefined)?.ts].find((v) => typeof v === "string" && TS.test(v)) as string | undefined;
  const link = /(https?:\/\/[^\s"')\]]+\/archives\/[A-Z0-9]+\/p(\d{10})(\d{6})[^\s"')\]]*)/.exec(raw);
  return { ts: direct ?? (link ? `${link[2]}.${link[3]}` : null), permalink: link?.[1] ?? null };
}

/** Loose text identity for recovery: Slack rewrites Markdown, so compare letters and digits only. */
export { sameLooseText as sameText } from "./common.ts";
