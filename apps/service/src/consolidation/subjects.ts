/** What Consolidation reads: a finished Harness session, or a meeting capture that arrived in the Brain. */
export type ConsolidationSubject = "session" | "meeting";

/** How everything Consolidation says, to the model and to the owner, names what it read. */
export interface SubjectWording {
  /** The word for what was read, in prompts and in what was dropped. */
  noun: string;
  /** What the model reads, in its instructions. */
  reads: string;
  /** What in it the model leaves out. */
  ignore: string;
  /** The line before the text in the prompt. */
  intro: string;
  /** Job progress while the model reads it. */
  reading: string;
  /** Why nothing was read when no model is connected. */
  noModel: string;
}

export const SUBJECTS: Readonly<Record<ConsolidationSubject, SubjectWording>> = {
  session: {
    noun: "session",
    reads: "one finished Harness session",
    ignore: "Ignore chatter, plans that were not agreed, file paths, command output, and facts the session only read back from memory.",
    intro: "The session transcript follows between the markers.",
    reading: "Reading the session",
    noModel: "No model is connected, so Attache did not consolidate this session. Connect a model in Connections to consolidate the next one.",
  },
  meeting: {
    noun: "meeting",
    reads: "the capture of one meeting: its notes and, when there is one, its transcript",
    ignore: "Ignore small talk, ideas and plans that were not agreed, and what the meeting only repeated from before.",
    intro: "The meeting capture follows between the markers.",
    reading: "Reading the meeting",
    noModel: "No model is connected, so Attache did not consolidate this meeting capture. Connect a model in Connections to consolidate the next one.",
  },
};
