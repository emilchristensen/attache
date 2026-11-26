// What a release manifest may say, as a table of cases: its version's channel and what a reader refuses.
import { describe, expect, it } from "vitest";
import { channelOf, parseManifest, writeManifest } from "../src/release/manifest.ts";
import { generateReleaseKeyPair } from "../src/release/signature.ts";

const ARTIFACT = { name: "attache-0.7.0-linux-x64.tar.gz", size: 10, sha256: "a".repeat(64) };
const valid = { manifestVersion: 1, version: "0.7.0", channel: "stable", publishedAt: "2026-11-26T09:00:00.000Z", notes: "## 0.7.0\n", artifacts: { "linux-x64": ARTIFACT } };
const bytes = (m: unknown) => Buffer.from(JSON.stringify(m));

describe("the Update channel of a version", () => {
  it.each([
    ["0.7.0", "stable"],
    ["1.0.0", "stable"],
    ["0.7.0-beta.1", "beta"],
    ["0.7.0-beta.12", "beta"],
  ])("%s is %s", (version, channel) => {
    expect(channelOf(version)).toBe(channel);
  });

  it.each(["0.7", "v0.7.0", "0.7.0-rc.1", "0.7.0-beta", "0.7.0-beta.01", "07.0.0"])("refuses %s, which no release carries", (version) => {
    expect(() => channelOf(version)).toThrow(/not a release version/);
  });
});

describe("reading a manifest", () => {
  it("reads one the release build wrote, with its next key", () => {
    const next = generateReleaseKeyPair().publicKey;
    const m = parseManifest(writeManifest({ version: "0.7.0-beta.2", publishedAt: new Date("2026-11-26T09:00:00Z"), notes: "notes", artifacts: { "linux-x64": ARTIFACT }, nextPublicKey: next }));
    expect(m).toMatchObject({ version: "0.7.0-beta.2", channel: "beta", publishedAt: "2026-11-26T09:00:00.000Z", nextPublicKey: next });
  });

  it.each([
    ["a channel its version does not belong to", { ...valid, channel: "beta" }, /channel/],
    ["a newer manifest layout", { ...valid, manifestVersion: 2 }, /manifestVersion/],
    ["an artifact outside the release folder", { ...valid, artifacts: { "linux-x64": { ...ARTIFACT, name: "../attache.tar.gz" } } }, /artifacts/],
    ["a checksum that is not SHA-256", { ...valid, artifacts: { "linux-x64": { ...ARTIFACT, sha256: "abc" } } }, /sha256/],
    ["no artifact", { ...valid, artifacts: {} }, /names no artifact/],
    ["a next key that is not an Ed25519 public key", { ...valid, nextPublicKey: "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----\n" }, /nextPublicKey/],
  ])("refuses %s", (_, manifest, why) => {
    expect(() => parseManifest(bytes(manifest))).toThrow(why);
  });

  it("refuses bytes that are not JSON", () => {
    expect(() => parseManifest(Buffer.from("{"))).toThrow(/not JSON/);
  });
});
