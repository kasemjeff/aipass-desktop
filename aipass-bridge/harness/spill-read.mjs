// Ranged spill reads without loading the whole file.
//
// A background job may write up to 20 MB and a result spill may be larger;
// `read` used to load all of it to return a 250-line page. This streams
// line-by-line (async, never blocks the backend's event loop), counts
// every line for the total, and keeps only the asked range bounded by
// maxResult — memory is the range, not the file.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/**
 * Read a spill file's range and return the same text `read` would for a
 * spill page: the kept lines verbatim plus the continuation note, or the
 * cut message when the range is too large to ride a message.
 * @param {string} abs
 * @param {string} rel
 * @param {[number, number]|null} range
 * @param {number} readLines
 * @param {number} maxResult
 * @returns {Promise<string>}
 */
export async function spillReadResult(abs, rel, range, readLines, maxResult) {
  const wantedStart = range ? range[0] : 1;
  const wantedEnd = range ? range[1] : readLines;
  let total = 0;
  const kept = /** @type {string[]} */ ([]);
  let bytes = 0;
  let truncated = false;
  let truncatedLine = /** @type {string|null} */ (null);
  const emit = (/** @type {string} */ line) => {
    total++;
    if (truncated) return;
    if (total < wantedStart || total > wantedEnd) return;
    const add = Buffer.byteLength(line, 'utf8') + (kept.length ? 1 : 0);
    if (kept.length && bytes + add > maxResult) { truncated = true; return; }
    if (!kept.length && add > maxResult) { truncatedLine = line; truncated = true; return; }
    kept.push(line);
    bytes += add;
  };
  try {
    const stream = fs.createReadStream(abs, { highWaterMark: 64 * 1024 });
    const decoder = new StringDecoder('utf8');
    let rest = '';
    for await (const chunk of stream) {
      rest += decoder.write(chunk);
      const parts = rest.split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) emit(part);
    }
    rest += decoder.end();
    if (rest !== '') emit(rest);
  } catch {
    return `err: no such file: ${rel}`;
  }
  if (range) {
    const [from, to] = range;
    if (from > to) return `err: ${rel} has ${total} line(s). The range ${from}-${to} runs backwards — ask for ${to}-${from} instead.`;
    if (from > total) return `err: ${rel} has ${total} line(s). Line ${from} is past the end — ask for a range within it.`;
  }
  const start = range ? range[0] : 1;
  const end = range ? Math.min(range[1], total) : Math.min(total, readLines);
  let note = '';
  if (end < total) note = `\n… ${total - end} more line(s). To see them: NEED file ${rel} ${end + 1}-${Math.min(total, end + readLines)}`;
  else if (start > 1) note = `\n(lines ${start}-${end} of ${total})`;
  if (truncatedLine !== null) {
    const slice = truncatedLine.slice(0, Math.max(1, Math.floor(maxResult / 4)));
    return `${slice}\n… the range was cut at ${maxResult} bytes — a spill read is never spilled again; ask for a smaller range, e.g. ${start}-${Math.min(end, start + 200)}.${note}`;
  }
  const text = kept.join('\n');
  // A range that ran past the end was already clamped; truncated only
  // means the byte cap cut it, exactly as the whole-file path did.
  const wantedCount = Math.max(0, end - start + 1);
  if (!truncated || kept.length === wantedCount) return text + note;
  return `${text}\n… the range was cut at ${maxResult} bytes — a spill read is never spilled again; ask for a smaller range, e.g. ${start}-${Math.min(end, start + 200)}.${note}`;
}
