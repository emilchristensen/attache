import type { MeaningStatus } from "@jarvis/contracts";

const percent = (part: number, whole: number) => (whole > 0 ? Math.floor((part / whole) * 100) : 0);

/** One line telling a reader of search results why they match keywords only, or null once search ranks by meaning. */
export function meaningNote(status: MeaningStatus): string | null {
  switch (status.state) {
    case "missing":
      return "Results match keywords only: the meaning model is not downloaded. The owner can download it in the Dashboard's Settings.";
    case "downloading":
      return `Results match keywords only: the meaning model is downloading (${percent(status.download?.received ?? 0, status.download?.total ?? 0)}%).`;
    case "failed":
      return `Results match keywords only: meaning-based search stopped (${status.error ?? "unknown error"}). The owner can start the download again in the Dashboard's Settings.`;
    case "building":
      return `Results match keywords only while search vectors are built (${status.vectors.embedded} of ${status.vectors.chunks} passages).`;
    case "ready":
      return null;
  }
}
