import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig } from "./config.js";
import { loadDocContext } from "./doc-fetcher.js";

export async function handleWaiSearchCommand(
  args: string,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const query = args.trim();
  if (!query) {
    return { content: [{ type: "text", text: "Usage: /wai-search <query>" }] };
  }
  const config = loadYoowaiConfig(ctx.cwd);
  if (!config.docs?.webSearch?.enabled) {
    return {
      content: [
        {
          type: "text",
          text: "Web search is disabled. Enable it with pi-yoowai.docs.webSearch.enabled in settings.json.",
        },
      ],
    };
  }
  const result = await loadDocContext(ctx.cwd, config.docs, { search: query });
  if (!result) {
    return { content: [{ type: "text", text: `No results for "${query}".` }] };
  }
  return { content: [{ type: "text", text: `Web search results for "${query}":\n\n${result}` }] };
}
