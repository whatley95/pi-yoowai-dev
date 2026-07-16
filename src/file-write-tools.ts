/**
 * Pi's built-in file-mutating tools, from pi-coding-agent's core tools
 * (read, write, edit, bash, find, grep, ls). Only write/edit count as file
 * edits: "bash" can also mutate files, but treating every shell command as an
 * edit would over-trigger review/done reminders.
 *
 * The set is explicit rather than a name regex so a new or renamed Pi tool is
 * caught by the unit test instead of silently changing reminder behavior.
 * Lowercase aliases cover older/alternate Pi tool naming.
 */
const FILE_WRITE_TOOLS = new Set(["write", "edit", "writefile", "editfile", "applypatch"]);

/** True when the named tool is known to mutate project files. */
export function isFileWriteTool(toolName: string): boolean {
  return FILE_WRITE_TOOLS.has(toolName.trim().toLowerCase());
}
