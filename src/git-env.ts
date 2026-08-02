/** Spawn environment for git subprocesses with ambient GIT_* redirectors
 *  stripped. When the extension itself runs inside a git hook (e.g. a CI
 *  pre-push running wai review), git exports GIT_DIR/GIT_WORK_TREE/
 *  GIT_INDEX_FILE, and GIT_CONFIG_PARAMETERS can re-inject config — leaving
 *  them in place would redirect `git ls-files`/`git diff` at the WRONG
 *  repository (the hook's repo) instead of the project under review. */
export function gitSpawnEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"]) {
    delete env[key];
  }
  return env;
}
