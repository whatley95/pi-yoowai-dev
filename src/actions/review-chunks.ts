import { splitDiffByHunk } from "../diff-grabber.js";

/** Preserve every patch row and absolute old/new coordinates. Overlap is
 * review context, not another change; segments are never applied as patches. */
export function splitReviewDiff(diff: string, maxChars: number): string[] {
  if (diff.length <= maxChars) return [diff];
  const chunks: string[] = [];
  for (const hunk of splitDiffByHunk(diff)) {
    if (hunk.length <= maxChars) {
      chunks.push(hunk);
      continue;
    }
    const lines = hunk.split("\n");
    const index = lines.findIndex((line) => /^@@ /.test(line));
    const match = lines[index]?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (!match) throw new Error("The oversized diff has no splittable text hunk (binary/property/header evidence).");
    const header = lines.slice(0, index).join("\n") + "\n";
    const rows = lines.slice(index + 1);
    if (rows.at(-1) === "") rows.pop();
    if (rows.some((row) => !/^[ +\\-]/.test(row)))
      throw new Error("The oversized diff contains unsupported hunk rows; complete evidence cannot be segmented.");
    const oldOffsets = [Number(match[1])],
      newOffsets = [Number(match[3])];
    for (const row of rows) {
      oldOffsets.push(oldOffsets.at(-1)! + (/^[ -]/.test(row) ? 1 : 0));
      newOffsets.push(newOffsets.at(-1)! + (/^[ +]/.test(row) ? 1 : 0));
    }
    const render = (start: number, end: number) =>
      `${header}@@ -${oldOffsets[start]},${oldOffsets[end] - oldOffsets[start]} +${newOffsets[start]},${newOffsets[end] - newOffsets[start]} @@${match[5]}\n${rows.slice(start, end).join("\n")}\n`;
    for (let start = 0; start < rows.length;) {
      let end = start;
      let size = 0;
      // Count payload incrementally; render only the final candidate, avoiding
      // quadratic string construction for large additions.
      while (end < rows.length) {
        const next = size + rows[end].length + 1;
        if (header.length + match[5].length + 100 + next > maxChars) break;
        size = next;
        end++;
      }
      if (end === start)
        throw new Error(
          "A single diff line or its header exceeds the available review context; use a larger-context model.",
        );
      if (rows[end]?.startsWith("\\")) {
        if (render(start, end + 1).length <= maxChars) end++;
        else end--;
      }
      if (end <= start) throw new Error("A diff line and its newline marker cannot fit the review context.");
      chunks.push(render(start, end));
      if (end === rows.length) break;
      const previousStart = start;
      start = end - Math.min(3, end - start - 1);
      // A newline marker belongs to the preceding row, including in overlap.
      if (rows[start]?.startsWith("\\")) start--;
      if (start <= previousStart) start = end;
    }
  }
  const packed: string[] = [];
  for (const chunk of chunks) {
    const marker = chunk.search(/^@@ /m);
    const header = chunk.slice(0, marker);
    const last = packed.at(-1);
    const suffix = chunk.slice(marker);
    if (marker >= 0 && last?.startsWith(header) && last.length + suffix.length + 1 <= maxChars)
      packed[packed.length - 1] = last + "\n" + suffix;
    else packed.push(chunk);
  }
  return packed;
}

/** Only a complete addition of this exact source is duplicate evidence.
 * Never infer equivalence for edited/deleted/truncated files or chunks. */
export function additionContainsSource(diff: string, content: string): boolean {
  if (!/^--- (?:\/dev\/null|[^\n]*\(nonexistent\))\r?$/m.test(diff)) return false;
  const hunks = splitDiffByHunk(diff);
  if (hunks.length !== 1) return false;
  const lines = hunks[0].split(/\r?\n/);
  const index = lines.findIndex((line) => /^@@ -0,0 \+1(?:,\d+)? @@/.test(line));
  if (index < 0) return false;
  const count = Number(lines[index].match(/^@@ -0,0 \+1(?:,(\d+))? @@/)?.[1] ?? 1);
  const rows = lines.slice(index + 1);
  if (rows.at(-1) === "") rows.pop();
  const noNewline = rows.at(-1) === "\\ No newline at end of file";
  if (noNewline) rows.pop();
  if (rows.length !== count || rows.some((line) => !line.startsWith("+"))) return false;
  const captured = rows.map((line) => line.slice(1)).join("\n") + (noNewline ? "" : "\n");
  return captured === content.replaceAll("\r\n", "\n");
}
