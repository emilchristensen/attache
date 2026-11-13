// Comments are for maintainers: file(s) and job(s) are fine here.
import { plural } from "./wording.ts";

const files = (n: number) => `${plural(n, "file")} read`;
const scheme = "Enter a valid http(s) base URL";
const HTTPS_ONLY = "HTTP(S) proxies are not supported";
const note = "Use (s) only in code, never in text";
export { files, scheme, HTTPS_ONLY, note };
