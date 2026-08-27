import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitSpawnEnv } from "../git-env.js";

/** Minimal git+stub-server harness shared by the action integration tests
 *  (test/security/judge). Review has its own richer harness in review.test.ts
 *  (kept untouched as the regression baseline). */

export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function gitOpts() {
  return { stdio: "pipe" as const, env: gitSpawnEnv() };
}

export function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, ...gitOpts() });
  execFileSync("git", ["config", "user.email", "wai-test@example.com"], { cwd: dir, ...gitOpts() });
  execFileSync("git", ["config", "user.name", "wai test"], { cwd: dir, ...gitOpts() });
}

export function commitAll(dir: string, message = "wip"): void {
  execFileSync("git", ["add", "."], { cwd: dir, ...gitOpts() });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", message], { cwd: dir, ...gitOpts() });
}

export function writeSettings(cwd: string, piYoowai: Record<string, unknown>): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, "settings.json"), JSON.stringify({ "pi-yoowai": piYoowai }), "utf-8");
}

/** Prepare a repo that mirrors the commit-per-round workflow: .pi is
 *  gitignored, the given files are committed, then changed. */
export function prepareRepo(cwd: string, initial: Record<string, string>, changed: Record<string, string>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
  for (const [name, content] of Object.entries(initial)) {
    writeFileSync(join(cwd, name), content);
  }
  commitAll(cwd, "init");
  for (const [name, content] of Object.entries(changed)) {
    writeFileSync(join(cwd, name), content);
  }
  commitAll(cwd, "round1");
}

/** A locally stubbed OpenAI-compatible endpoint returning the configured JSON
 *  payload for every request. With failOnMarker, requests containing the
 *  marker get a 500 (the http backend retries by default — use maxRetries: 0
 *  in settings to fail fast). The Server handle is returned so callers can
 *  close it in teardown. */
export async function startStubServer(options?: {
  payload?: unknown;
  failOnMarker?: string;
}): Promise<{ url: string; bodies: string[]; server: Server }> {
  const bodies: string[] = [];
  const payload = options?.payload ?? { verdict: "pass", findings: [], summary: "ok" };
  const failOnMarker = options?.failOnMarker;
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf-8");
      });
      req.on("end", () => {
        bodies.push(body);
        if (failOnMarker && body.includes(failOnMarker)) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "stub failure" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(payload) } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        );
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub server has no port");
  return { url: `http://127.0.0.1:${address.port}`, bodies, server };
}

/** Close a stub server, force-closing keep-alive sockets so the test process
 *  cannot hang on open connections. */
export function closeStubServer(server?: Server): void {
  if (!server) return;
  server.closeAllConnections?.();
  server.close();
}

export function bodyText(bodies: string[], index: number): string {
  const body = bodies[index];
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> };
    const user = parsed.messages?.find((m) => m.role === "user");
    return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
  } catch {
    return body;
  }
}
