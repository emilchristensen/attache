/**
 * A refresh asked for by live events. The first request schedules a run after `delayMs`; later requests before it
 * runs join it rather than postpone it. So resources asked again on one event start together even when a later event
 * concerns only one of them, and a steady stream of events still refreshes, where a debounce would wait for quiet.
 * The run starts after every request it joined, so it reads everything they announced.
 */
export function joinedRefresh(run: () => void, delayMs: number): { request(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    request() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
