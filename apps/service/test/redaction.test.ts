import { describe, expect, it } from "vitest";
import { findSecrets, redact, registerSecret } from "../src/core/redaction.ts";

// One literal per kind of credential redaction knows, built at run time so no scanner mistakes this file for a leak.
const SAMPLES: Record<string, string> = {
  "GitHub token": ["ghp", "Q7f2Lk9Xw3Rt8Vb1Nm4Pz6Hc0Jd5Gs2Ya8Ue"].join("_"),
  "GitHub fine-grained token": ["github", "pat", "11ABCDEFG0123456789_abcdefghijklmnop"].join("_"),
  "Slack token": ["xoxb", "123456789012-abcdefABCDEF"].join("-"),
  "Anthropic key": ["sk", "ant", "api03-abcdefghijklmnop"].join("-"),
  "API key": ["sk", "proj_abcdefghijklmnopqrstuvwx"].join("-"),
  "AWS key": ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  "Google token": ["ya29", "a0AfH6SMBabcdefghijklmnop"].join("."),
  "JSON web token": ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N"].join("."),
  "private key": ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA", "-----END RSA PRIVATE KEY-----"].join("\n"),
  "authorization header": ["Bearer", "abcdefghijklmnop.qrstuv"].join(" "),
  "Atlassian token": ["ATATT", "3xFfGF0abcdefghijklmnopqrstu"].join(""),
};

describe("The credential scan and redaction agree on what a secret is", () => {
  it.each(Object.entries(SAMPLES))("a %s is both redacted and found, on the line it starts", (_kind, secret) => {
    const text = `# Note\n\nSee below.\nvalue: ${secret}\n`;
    expect(redact(text)).not.toContain(secret);
    expect(findSecrets(text)).toEqual([{ line: 4, kind: expect.any(String) }]);
  });

  it("a secret the service holds is both redacted and found, even without a known shape", () => {
    const held = "plain-looking-connection-secret-42";
    registerSecret(held);
    expect(redact(`token ${held}`)).toBe("token [REDACTED]");
    expect(findSecrets(`first\n${held}`)).toEqual([{ line: 2, kind: "a secret Jarvis holds" }]);
  });

  it("ordinary text is neither redacted nor found", () => {
    const text = "# Orion migration\n\n- Status: Cutover planned for October\n- Owner: sk-team in Basic training\n";
    expect(redact(text)).toBe(text);
    expect(findSecrets(text)).toEqual([]);
  });

  it("a secret that is in an earlier version already is not new", () => {
    const secret = SAMPLES["GitHub token"]!;
    const before = `Token: ${secret}\n`;
    expect(findSecrets(`${before}More text.\n`, [before])).toEqual([]);
  });
});
