import { describe, expect, it } from "vitest";
import { parseToolResult } from "../../src/connectors/atlassian.ts";
import { RemoteError } from "../../src/connectors/http.ts";

describe("an Atlassian MCP tool error", () => {
  const failure = (result: { text: string; isError: boolean }): RemoteError => {
    try {
      parseToolResult("searchJiraIssuesUsingJql", result);
    } catch (e) {
      return e as RemoteError;
    }
    throw new Error("the tool result did not fail");
  };

  it("says the HTTP status the server answered with, so a server error never reads as a network failure", () => {
    const e = failure({ text: JSON.stringify({ error: true, message: "upstream connection refused", statusCode: 502 }), isError: true });
    expect(e.message).toBe("Atlassian searchJiraIssuesUsingJql failed (HTTP 502): upstream connection refused");
    expect(e.state).toBe("offline");
  });

  it("says no status when the server gave none", () => {
    expect(failure({ text: "tool crashed", isError: true }).message).toBe("Atlassian searchJiraIssuesUsingJql failed: tool crashed");
  });
});
