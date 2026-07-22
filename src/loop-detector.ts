interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface LoopDetectionState {
  recentCalls: ToolCallRecord[];
  lastSteerAt: number;
  lastSteerSignature: string;
}

export function createLoopDetectionState(): LoopDetectionState {
  return { recentCalls: [], lastSteerAt: 0, lastSteerSignature: "" };
}

const MAX_HISTORY = 16;
const COOLDOWN_MS = 20_000;

export function recordToolCall(state: LoopDetectionState, event: unknown): void {
  try {
    const e = event as Record<string, unknown> | undefined;
    if (!e) return;

    const toolName = typeof e.toolName === "string" ? e.toolName : "";
    const args =
      e.args && typeof e.args === "object" && !Array.isArray(e.args) ? (e.args as Record<string, unknown>) : {};

    if (!toolName) return;

    state.recentCalls.push({ toolName, args, timestamp: Date.now() });
    while (state.recentCalls.length > MAX_HISTORY) {
      state.recentCalls.shift();
    }
  } catch {
    // best-effort
  }
}

function isWaiToolName(toolName: string): boolean {
  return toolName === "wai" || toolName === "yoo" || toolName.startsWith("wai_") || toolName.startsWith("yoo_");
}

export function checkLoop(state: LoopDetectionState): { looping: boolean; message: string } | null {
  const calls = state.recentCalls;
  if (calls.length < 5) return null;

  // Pattern 1: wai/yoo called 5+ times in a row without other tools doing real work
  const recentWai = calls.slice(-5);
  const waiCalls = recentWai.filter((c) => isWaiToolName(c.toolName));
  const nonWaiCalls = recentWai.filter((c) => !isWaiToolName(c.toolName));
  const realWorkCalls = nonWaiCalls.filter((c) => !isReadOnlyTool(c.toolName));

  if (waiCalls.length >= 5 && realWorkCalls.length === 0) {
    return {
      looping: true,
      message:
        "LOOP DETECTED: you keep calling wai tools without making real edits. STOP. Pick one concrete issue, fix it in the actual code, then call wai.review once. If stuck, ask the user or use wai.suggest.",
    };
  }

  // Pattern 2: same wai action called repeatedly with identical description
  const last = calls[calls.length - 1];
  if (isWaiToolName(last.toolName)) {
    const sameDescriptionCount = countIdenticalDescriptions(calls, last);
    if (sameDescriptionCount >= 5) {
      return {
        looping: true,
        message:
          "LOOP DETECTED: you are repeating the same wai call with the same description. STOP. The previous result should already guide you. Apply a real change or ask the user if blocked.",
      };
    }
  }

  return null;
}

function countIdenticalDescriptions(calls: ToolCallRecord[], target: ToolCallRecord): number {
  const targetDesc = getWaiDescription(target.args);
  if (!targetDesc) return 0;

  const targetAction = getWaiActionKey(target.args);
  let count = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (!isWaiToolName(c.toolName)) break;
    if (getWaiActionKey(c.args) !== targetAction) break;
    if (getWaiDescription(c.args) === targetDesc) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

export function getWaiActionKey(args: Record<string, unknown>): string {
  if (typeof args.review === "string") return "review";
  if (typeof args.judge === "string") return "judge";
  if (typeof args.plan === "string") return "plan";
  if (typeof args.suggest === "string") return "suggest";
  if (typeof args.recommend === "string") return "recommend";
  if (args.scan === true) return "scan";
  return "";
}

function isReadOnlyTool(toolName: string): boolean {
  return toolName === "readFile" || toolName === "grep" || toolName === "glob";
}

function getWaiDescription(args: Record<string, unknown>): string {
  const description =
    (typeof args.review === "string" ? args.review : "") ||
    (typeof args.judge === "string" ? args.judge : "") ||
    (typeof args.plan === "string" ? args.plan : "") ||
    (typeof args.suggest === "string" ? args.suggest : "") ||
    (typeof args.recommend === "string" ? args.recommend : "") ||
    (args.scan === true ? "[scan]" : "");
  return description.trim().toLowerCase().slice(0, 120);
}

export function shouldSendSteer(state: LoopDetectionState, loop: { message: string }): boolean {
  const signature = loop.message.slice(0, 80);
  const now = Date.now();
  if (signature === state.lastSteerSignature && now - state.lastSteerAt < COOLDOWN_MS) {
    return false;
  }
  state.lastSteerSignature = signature;
  state.lastSteerAt = now;
  return true;
}
