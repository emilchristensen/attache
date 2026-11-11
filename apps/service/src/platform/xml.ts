/** Text made safe to put between XML tags (a plist, a Task Scheduler definition, notification markup). */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
