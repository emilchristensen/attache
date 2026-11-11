import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Writer locks of services started by tests, and of the services they spawn, stay out of the real home folder.
process.env.JARVIS_LOCK_DIR ??= mkdtempSync(join(tmpdir(), "jarvis-test-locks-"));
