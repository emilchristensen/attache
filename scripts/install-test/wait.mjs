/**
 * The install test's one way to wait: look again until something holds or a deadline passes. A deadline, not a count
 * of tries, so a slow look (an HTTP request to a service still starting) does not stretch the wait.
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call `look` every 250 ms until it answers something truthy, or `seconds` have passed; resolves its last answer.
 * `look` may be async; one that throws counts as a falsy answer.
 */
export async function waitUntil(seconds, look) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const answer = await Promise.resolve()
      .then(look)
      .catch(() => null);
    if (answer || Date.now() >= end) return answer;
    await sleep(250);
  }
}
