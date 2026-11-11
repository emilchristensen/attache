import { describe, expect, it } from "vitest";
import { assertNoRewrite } from "../src/replication/git.ts";

const refused = /never force-pushes or deletes/;

describe("Replication's git guard", () => {
  it("refuses every forced push and every deletion of the Brain's branch", () => {
    for (const args of [
      ["push", "--force", "origin", "main"],
      ["push", "origin", "+main:main"],
      ["push", "--force-with-lease", "origin", "main"],
      ["push", "origin", ":refs/heads/main"],
      ["push", "--delete", "origin", "refs/jarvis/reader-lease/1"],
      ["push", "origin", ":refs/jarvis/candidate"],
      ["push", "origin", ":refs/jarvis/reader-lease/x"],
      ["push", "origin", "+abc:refs/jarvis/reader-lease/2"],
    ]) {
      expect(() => assertNoRewrite(args), args.join(" ")).toThrow(refused);
    }
  });

  it("lets a retired Reader lease generation be deleted alongside the lease's move to the next one", () => {
    expect(() => assertNoRewrite(["push", "--quiet", "--atomic", "origin", "abc:refs/jarvis/reader-lease/3", "def:refs/jarvis/reader-lease/4", ":refs/jarvis/reader-lease/2"])).not.toThrow();
  });
});
