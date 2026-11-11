import type { ConnectionKind } from "@jarvis/contracts";
import type { ConnectorAdapter } from "./types.ts";
import { githubAdapter } from "./github.ts";
import { jiraAdapter } from "./jira.ts";
import { confluenceAdapter } from "./confluence.ts";
import { slackAdapter } from "./slack.ts";
import { gmailAdapter } from "./gmail.ts";
import { gcalAdapter } from "./gcal.ts";
import { modelAdapter } from "./model.ts";
import { vaultAdapter } from "./vault.ts";

/** Every connection Jarvis supports. Each entry is a real adapter with setup, test and (for sources) Source refresh. */
export const ADAPTERS = new Map<ConnectionKind, ConnectorAdapter>([
  ["vault", vaultAdapter],
  ["github", githubAdapter],
  ["jira", jiraAdapter],
  ["confluence", confluenceAdapter],
  ["slack", slackAdapter],
  ["gmail", gmailAdapter],
  ["gcal", gcalAdapter],
  ["model", modelAdapter],
]);
