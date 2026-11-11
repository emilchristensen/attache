// Preloaded with `node --import` so the `jarvis` executable believes it runs on another operating system.
// Only the reported platform changes; the file system and processes are still this machine's.
const fake = process.env.JARVIS_TEST_FAKE_PLATFORM;
if (fake) Object.defineProperty(process, "platform", { value: fake });
