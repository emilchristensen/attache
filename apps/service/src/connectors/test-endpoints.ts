/**
 * Endpoint overrides used ONLY for automated contract and end-to-end tests.
 * They are active only when JARVIS_TEST_ENDPOINTS=1 and JARVIS_FIXTURE_URL
 * points at the test fixture server. Normal operation never sets these.
 * The claude.ai connectors are reached through the Claude Code CLI, which
 * tests replace with test/fixtures/fake-claude.mjs via JARVIS_CLAUDE_BIN.
 */
export const FIXTURE_PREFIX: Record<string, string> = {
  "https://api.github.com": "/github",
  "https://mcp.atlassian.com": "/atlassian-mcp",
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
