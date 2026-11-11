import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Writer locks of services started by tests, and of the services they spawn, stay out of the real home folder.
process.env.JARVIS_LOCK_DIR ??= mkdtempSync(join(tmpdir(), "jarvis-test-locks-"));

// Git runs as on a fresh computer: no user name or email and no settings of the developer's own, as on CI.
// An empty file, not the null device: Git for Windows cannot open `\\.\nul` as a config file.
const emptyGitConfig = join(mkdtempSync(join(tmpdir(), "jarvis-test-git-")), "gitconfig");
writeFileSync(emptyGitConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
