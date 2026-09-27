const sessions = new Map<string, AbortController>();

/** In-flight work retains its controller; cancelling cannot authorize a stale result in a replacement session. */
export function beginSessionWork(
  cwd: string,
  parent?: AbortSignal,
): { signal: AbortSignal; isCurrent: () => boolean; isGenerationCurrent: () => boolean } {
  let controller = sessions.get(cwd);
  if (!controller) {
    controller = new AbortController();
    sessions.set(cwd, controller);
  }
  const captured = controller;
  return {
    signal: parent ? AbortSignal.any([parent, captured.signal]) : captured.signal,
    isCurrent: () => sessions.get(cwd) === captured && !captured.signal.aborted && !parent?.aborted,
    isGenerationCurrent: () => sessions.get(cwd) === captured,
  };
}

export function cancelSessionWork(cwd: string): void {
  const controller = sessions.get(cwd);
  sessions.delete(cwd);
  controller?.abort(new Error("Wai work cancelled: session changed or shutdown."));
}
