/**
 * Endpoint overrides used ONLY for automated contract and end-to-end tests.
 * They are active only when JARVIS_TEST_ENDPOINTS=1 and JARVIS_FIXTURE_URL
 * points at the test fixture server. Normal operation never sets these.
 */
export const FIXTURE_PREFIX: Record<string, string> = {
  "https://api.github.com": "/github",
  "https://slack.com/api": "/slack",
  "https://oauth2.googleapis.com": "/google-oauth",
  "https://accounts.google.com": "/google-accounts",
  "https://gmail.googleapis.com": "/gmail",
  "https://www.googleapis.com": "/gcal",
};

export function testEndpointsActive(): boolean {
  return process.env.JARVIS_TEST_ENDPOINTS === "1" && !!process.env.JARVIS_FIXTURE_URL;
}

export function resolveEndpoint(defaultBase: string): string {
  if (!testEndpointsActive()) return defaultBase;
  const trimmed = defaultBase.replace(/\/$/, "");
  const prefix = FIXTURE_PREFIX[trimmed];
  return prefix ? `${process.env.JARVIS_FIXTURE_URL!.replace(/\/$/, "")}${prefix}` : defaultBase;
}
