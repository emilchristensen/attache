/**
 * Browser specs say what they cover where an agent looks first: each `tests/e2e/*.spec.ts` opens with a
 * `/**` comment naming what it covers and whether it runs on its own (or needs the earlier tests of its file).
 * The developer guide points at these comments instead of listing every spec.
 */

/** A finding at line 1 when the file does not open with a `/**` comment, else none. */
export function findMissingSpecHeader(text) {
  const first = text.replace(/^﻿/, "").trimStart();
  return first.startsWith("/**") ? [] : [{ line: 1 }];
}
