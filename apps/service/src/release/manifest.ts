/**
 * A release manifest (ADR 0007): the version, its Update channel, the publish
 * time, the release notes in Markdown, and for each target the artifact's
 * file name, size and SHA-256. It may name the next public key, which is how
 * the signing key rotates. The manifest is signed over its exact bytes, so it
 * is read back only from those bytes, never rebuilt from the parsed object.
 */
import { z } from "zod";
import type { UpdateChannel } from "@attache/contracts";
import { parsePublicKey } from "./signature.ts";

/** The manifest layout this version writes and reads. A newer layout gets a new number. */
export const MANIFEST_VERSION = 1;

/** A release version: `x.y.z` for Stable, `x.y.z-beta.N` for Beta. */
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta\.(0|[1-9]\d*))?$/;

/** Whether a version is one a release can carry. */
export const isReleaseVersion = (version: string): boolean => RELEASE_VERSION.test(version);

/** The Update channel a version belongs to: Beta for `-beta.N`, otherwise Stable. */
export function channelOf(version: string): UpdateChannel {
  const m = RELEASE_VERSION.exec(version);
  if (!m) throw new Error(`${version} is not a release version: use x.y.z for Stable or x.y.z-beta.N for Beta.`);
  return m[4] ? "beta" : "stable";
}

/** The manifest's file name in a release folder. */
export const manifestFileName = (version: string): string => `attache-${version}-manifest.json`;
/** Its detached signature's file name. */
export const signatureFileName = (version: string): string => `${manifestFileName(version)}.sig`;

/** A file name inside a release folder: no folders, nothing hidden. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPublicKey(pem: string): boolean {
  try {
    parsePublicKey(pem);
    return true;
  } catch {
    // Not a key: the schema reports it with the field's name.
    return false;
  }
}

const artifactSchema = z.object({
  name: z.string().regex(FILE_NAME),
  size: z.int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const manifestSchema = z
  .object({
    manifestVersion: z.literal(MANIFEST_VERSION),
    version: z.string().regex(RELEASE_VERSION),
    channel: z.enum(["stable", "beta"]),
    publishedAt: z.iso.datetime(),
    notes: z.string(),
    artifacts: z.record(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), artifactSchema).refine((a) => Object.keys(a).length > 0, "names no artifact"),
    nextPublicKey: z.string().refine(isPublicKey, "is not an Ed25519 public key").optional(),
  })
  .refine((m) => m.channel === channelOf(m.version), { message: "names a channel its version does not belong to", path: ["channel"] });

export type ReleaseArtifact = z.infer<typeof artifactSchema>;
export type ReleaseManifest = z.infer<typeof manifestSchema>;

/** The manifest these bytes hold; throws, saying what is wrong, when they hold none. */
export function parseManifest(bytes: Uint8Array): ReleaseManifest {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (e) {
    throw new Error(`The release manifest is not JSON: ${(e as Error).message}`, { cause: e });
  }
  const r = manifestSchema.safeParse(json);
  if (!r.success) throw new Error(`The release manifest is not one Attache can read: ${r.error.issues.map((i) => `${i.path.join(".") || "manifest"} ${i.message}`).join("; ")}`);
  return r.data;
}

export interface ManifestInput {
  version: string;
  publishedAt: Date;
  notes: string;
  artifacts: Record<string, ReleaseArtifact>;
  nextPublicKey?: string;
}

/** The bytes of a new manifest, checked as a reader will check them. */
export function writeManifest(input: ManifestInput): Buffer {
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    version: input.version,
    channel: channelOf(input.version),
    publishedAt: input.publishedAt.toISOString(),
    notes: input.notes,
    artifacts: Object.fromEntries(Object.entries(input.artifacts).sort(([a], [b]) => a.localeCompare(b))),
    ...(input.nextPublicKey ? { nextPublicKey: input.nextPublicKey } : {}),
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  parseManifest(bytes);
  return bytes;
}
