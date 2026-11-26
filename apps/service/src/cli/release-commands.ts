import { releaseTarget } from "../platform/release-target.ts";
import { keepNextReleaseKey, trustedReleaseKeys } from "../release/trusted-keys.ts";
import { verifyReleaseFolder } from "../release/verify-release.ts";
import type { CliIo } from "./memory-commands.ts";

const USAGE = "Usage: attache verify-release <release-folder> --version <x.y.z> [--target <target>] [--state-dir <path>] (the installer runs this)";

const option = (argv: readonly string[], name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);

/**
 * `attache verify-release <folder> --version <v>`: an installer run over an
 * existing install asks the installed version to check the new release before
 * it changes anything (ADR 0007). The folder holds the signed manifest, its
 * signature and this computer's artifact. The command reads only that folder
 * and the keys this Machine trusts; it never opens the database, so an older
 * version can check a newer release. On success it prints what it checked as
 * JSON and keeps a next key the manifest names; otherwise it exits non-zero
 * with the reason.
 *
 * `--supported` answers whether this version can check releases at all: one
 * from before signed releases fails with "Unknown command".
 */
export async function verifyReleaseCommand(argv: readonly string[], stateDir: string, io: CliIo): Promise<void> {
  if (argv.includes("--supported")) return;
  const folder = argv[1];
  const version = option(argv, "version");
  if (!folder || folder.startsWith("--") || !version) throw new Error(USAGE);
  const target = option(argv, "target") ?? releaseTarget();
  if (!target) throw new Error(`There is no Attache release for ${process.platform}/${process.arch}.`);
  const { manifest, artifacts } = await verifyReleaseFolder(folder, { trustedKeys: trustedReleaseKeys(stateDir), version, targets: [target] });
  keepNextReleaseKey(stateDir, manifest);
  io.out(JSON.stringify({ verified: true, version: manifest.version, channel: manifest.channel, target, artifact: artifacts[target]?.name }));
}
