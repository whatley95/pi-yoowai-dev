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
    const args = e.args && typeof e.args === "object" && !Array.isArray(e.args)
      ? (e.args as Record<string, unknown>)
      : {};

    if (!toolName) return;

    state.recentCalls.push({ toolName, args, timestamp: Date.now() });
    while (state.recentCalls.length > MAX_HISTORY) {
      state.recentCalls.shift();
    }
  } catch {
    // best-effort
  }
}

export function checkLoop(state: LoopDetectionState): { looping: boolean; message: string } | null {
  const calls = state.recentCalls;
  if (calls.length < 4) return null;

  // Pattern 1: yoo.review called 3+ times in a row without other tools
  const recentYoo = calls.slice(-5);
  const yooReviewCalls = recentYoo.filter((c) => c.toolName === "yoo" && (c.args.review || c.args.judge));
  const nonYooCalls = recentYoo.filter((c) => c.toolName !== "yoo");

  if (yooReviewCalls.length >= 3 && nonYooCalls.length === 0) {
    return {
      looping: true,
      message: "LOOP DETECTED: you keep calling yoo.review/yoo.judge without making real edits. STOP. Pick one concrete issue, fix it in the actual code, then call yoo.review once. If stuck, ask the user or use yoo.suggest.",
    };
  }

  // Pattern 2: same yoo action called repeatedly with identical description
  const last = calls[calls.length - 1];
  if (last.toolName === "yoo") {
    const sameDescriptionCount = countIdenticalDescriptions(calls, last);
    if (sameDescriptionCount >= 3) {
      return {
        looping: true,
        message: "LOOP DETECTED: you are repeating the same yoo call with the same description. STOP. The previous result should already guide you. Apply a real change or ask the user if blocked.",
      };
    }
  }

  return null;
}

function countIdenticalDescriptions(calls: ToolCallRecord[], target: ToolCallRecord): number {
  const targetDesc = getYooDescription(target.args);
  if (!targetDesc) return 0;

  let count = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (c.toolName !== "yoo") break;
    if (getYooDescription(c.args) === targetDesc) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function getYooDescription(args: Record<string, unknown>): string {
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
