/**
 * The HTTP requests a Playwright trace recorded, from its `*.network` files: each one's start, method, address,
 * status and bodies. A trace holds one network file per page and context, and some list the same request twice.
 */

/** A body is inline (`text`) or a file under `resources/` (`_file`, or `_sha1` in older traces). */
function body(part, files) {
  if (!part) return "";
  const name = part._file ?? part._sha1;
  if (!name) return part.text ?? "";
  const file = files.get(name.startsWith("resources/") ? name : `resources/${name}`);
  return file ? file.toString("utf8") : `(${name} is not in the trace)`;
}

/**
 * @param {Map<string, Buffer>} files the trace's files by name
 * @param {string} filter only requests whose path and query contain it
 * @returns {Array<{ at: string, method: string, path: string, status: number, request: string, response: string }>} oldest first
 */
export function traceRequests(files, filter = "") {
  const seen = new Set();
  const requests = [];
  for (const [name, data] of files) {
    if (!name.endsWith(".network")) continue;
    for (const line of data.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const { type, snapshot } = JSON.parse(line);
      if (type !== "resource-snapshot") continue;
      const url = new URL(snapshot.request.url);
      const path = `${url.pathname}${url.search}`;
      const key = `${snapshot.startedDateTime} ${snapshot.request.method} ${snapshot.request.url}`;
      if (!path.includes(filter) || seen.has(key)) continue;
      seen.add(key);
      requests.push({
        at: snapshot.startedDateTime,
        method: snapshot.request.method,
        path,
        status: snapshot.response.status,
        request: body(snapshot.request.postData, files),
        response: body(snapshot.response.content, files),
      });
    }
  }
  return requests.toSorted((a, b) => a.at.localeCompare(b.at));
}

/** One request per line, each body under it, cut to `width` characters unless `width` is 0. */
export function formatRequests(requests, width = 400) {
  const cut = (text) => (width && text.length > width ? `${text.slice(0, width)}… (${text.length} characters)` : text);
  return requests
    .flatMap((r) => [`${r.at.slice(11, 23)} ${r.method} ${r.path} ${r.status}`, ...(r.request ? [`  > ${cut(r.request)}`] : []), ...(r.response ? [`  < ${cut(r.response)}`] : [])])
    .join("\n");
}
