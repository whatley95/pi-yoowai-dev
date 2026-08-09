#!/usr/bin/env node
// pi-yoowai setup — configure the secondary model in ~/.pi/agent/settings.json.
// Plain Node, no dependencies. Usage:
//   npx pi-yoowai setup                 (interactive)
//   npx pi-yoowai setup --preset=openai (non-interactive)
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PRESETS = {
  "opencode-go-free": { provider: "opencode-go", id: "deepseek-v4-pro" },
  openai: { provider: "openai", id: "gpt-5-mini" },
  anthropic: { provider: "anthropic", id: "claude-sonnet-4-6" },
};

const ENV_VAR_HINTS = {
  "opencode-go": "OPENCODE_API_KEY (or Pi /login)",
  openai: "OPENAI_API_KEY (or Pi /login)",
  anthropic: "ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN (or Pi /login)",
};

// Vendored design reference topics (Emil Kowalski's skills, MIT) that can be
// installed as native Pi skills. Only these directory names are ever touched
// under ~/.pi/agent/skills/.
const DESIGN_SKILL_TOPICS = [
  "animate",
  "animation-vocabulary",
  "apple-design",
  "emil-design-eng",
  "find-animation-opportunities",
  "improve-animations",
  "pick-ui-library",
  "prototype",
  "review-animations",
];

function resolveSettingsPath() {
  const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
  return { agentDir, settingsPath: join(agentDir, "settings.json") };
}

function writeSecondary(provider, id) {
  const { agentDir, settingsPath } = resolveSettingsPath();

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (err) {
      console.error(`Failed to parse ${settingsPath}: ${err.message}`);
      process.exit(1);
    }
  }

  const existing = settings["pi-yoowai"];
  const wai = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  wai.secondary = { ...(wai.secondary || {}), provider, id };
  settings["pi-yoowai"] = wai;

  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return settingsPath;
}

function printNextSteps(provider, settingsPath) {
  const envHint = ENV_VAR_HINTS[provider] || `an API-key environment variable for ${provider} (or Pi /login)`;
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Make sure credentials for "${provider}" are available. pi-yoowai resolves API keys in this order:`);
  console.log("     pi-yoowai.secondary.apiKey -> ~/.pi/agent/auth.json -> environment variables -> !command.");
  console.log(`     For ${provider}, that usually means ${envHint}.`);
  console.log("  2. Restart Pi (or /reload) and run /wai-test to verify connectivity.");
  console.log("  3. Optional: tune spend with pi-yoowai.costBudgetUsd and per-tool pi-yoowai.taskModels.");
  console.log("");
  console.log(`Settings written to ${settingsPath}`);
}

function question(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

// Copy the vendored design reference topics into ~/.pi/agent/skills/ so Pi
// can auto-trigger them as native skills. Refresh semantics: the known topic
// directories are overwritten; nothing else under skills/ is touched.
function installDesignSkills() {
  const { agentDir } = resolveSettingsPath();
  const skillsDir = join(agentDir, "skills");
  const sourceRoot = fileURLToPath(new URL("../design-refs", import.meta.url));
  if (!existsSync(sourceRoot)) {
    console.log("Design references not found in this package; skipping design skills install.");
    return;
  }
  if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
  for (const topic of DESIGN_SKILL_TOPICS) {
    const source = join(sourceRoot, topic);
    if (!existsSync(source)) continue;
    cpSync(source, join(skillsDir, topic), { recursive: true });
  }
  const license = join(sourceRoot, "LICENSE");
  if (existsSync(license)) {
    cpSync(license, join(skillsDir, "design-refs-LICENSE"));
  }
  console.log(`Installed/refreshed ${DESIGN_SKILL_TOPICS.length} design skills in ${skillsDir}`);
  console.log("Re-run `npx pi-yoowai setup` after upgrades to refresh them.");
}

async function maybeInstallDesignSkills(rl) {
  const answer = await question(rl, "Install design reference skills into Pi? (y/n) ");
  if (answer.toLowerCase() !== "y") {
    console.log("Design skills skipped. To install them later, re-run `npx pi-yoowai setup` and answer y.");
    return;
  }
  installDesignSkills();
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "setup");
  const presetFlag = args.find((a) => a.startsWith("--preset="));

  if (presetFlag) {
    const name = presetFlag.slice("--preset=".length);
    const preset = PRESETS[name];
    if (!preset) {
      console.error(`Unknown preset "${name}". Available: ${[...Object.keys(PRESETS), "custom"].join(", ")}`);
      process.exit(1);
    }
    const settingsPath = writeSecondary(preset.provider, preset.id);
    console.log(`Configured pi-yoowai secondary model: ${preset.provider}:${preset.id}`);
    printNextSteps(preset.provider, settingsPath);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("pi-yoowai setup — pick a secondary model:");
    const names = Object.keys(PRESETS);
    names.forEach((name, i) => {
      console.log(`  ${i + 1}) ${name} (${PRESETS[name].provider}:${PRESETS[name].id})`);
    });
    console.log(`  ${names.length + 1}) custom (enter provider and model id)`);

    const choice = await question(rl, `Choice [1-${names.length + 1}]: `);
    const index = Number.parseInt(choice, 10) - 1;

    let provider;
    let id;
    if (index >= 0 && index < names.length) {
      ({ provider, id } = PRESETS[names[index]]);
    } else if (index === names.length) {
      provider = await question(rl, "Provider (e.g. openai, anthropic, opencode-go): ");
      id = await question(rl, "Model id (e.g. gpt-5-mini): ");
      if (!provider || !id) {
        console.error("Provider and model id are both required.");
        process.exit(1);
      }
    } else {
      console.error("Invalid choice.");
      process.exit(1);
    }

    const settingsPath = writeSecondary(provider, id);
    console.log(`Configured pi-yoowai secondary model: ${provider}:${id}`);
    printNextSteps(provider, settingsPath);
    await maybeInstallDesignSkills(rl);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`Setup failed: ${err.message}`);
  process.exit(1);
});
