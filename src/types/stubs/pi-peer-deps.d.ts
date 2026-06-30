declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
    registerTool(tool: {
      name: string;
      label?: string;
      description?: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters?: unknown;
      renderCall?: (
        args: unknown,
        theme: { fg(token: string, text: string): string; bg(token: string, text: string): string },
        context?: { lastComponent?: unknown },
      ) => unknown;
      renderResult?: (
        toolResult: unknown,
        opts: { expanded: boolean; isPartial?: boolean },
        theme: { fg(token: string, text: string): string; bg(token: string, text: string): string },
        context?: { lastComponent?: unknown },
      ) => unknown;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: (update: unknown) => void,
        ctx: ExtensionContext,
      ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }>;
    }): void;
    registerCommand(
      name: string,
      command: {
        description: string;
        handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
      },
    ): void;
    sendUserMessage(message: string, options?: Record<string, unknown>): void;
  }

  export interface ExtensionContext {
    cwd: string;
    model?: { id: string; provider: string; contextWindow?: number };
    modelRegistry: {
      getAvailable(): Array<{ id: string; provider: string }>;
    };
    sessionManager: {
      getHeader(): unknown;
      getBranch(): unknown[];
      getEntries(): unknown[];
    };
    ui: {
      theme: {
        fg(token: string, text: string): string;
        bg(token: string, text: string): string;
      };
      notify(message: string, level?: "info" | "warn" | "error"): void;
      select(title: string, items: string[]): Promise<string | undefined>;
      setStatus(key: string, value: string | undefined): void;
      setWidget(key: string, value: unknown): void;
    };
  }

  export function getAgentDir(): string;
}
