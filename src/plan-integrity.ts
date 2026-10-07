/** Semantic checks run before schema coercion and at every plan save boundary. */
export function planIntegrityErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  const errors: Array<{ path: string; message: string; value: unknown }> = [];
  if (!data || typeof data !== "object" || !("todo" in data) || !Array.isArray(data.todo)) return errors;
  const ids = new Set<string>();
  data.todo.forEach((item: unknown, index: number) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const step = item as Record<string, unknown>;
    if (step.id !== undefined) {
      if (typeof step.id !== "string" || !/^[\w-]{1,80}$/.test(step.id) || ids.has(step.id)) {
        errors.push({
          path: `/todo/${index}/id`,
          message: "Step IDs must be unique, nonempty identifiers",
          value: step.id,
        });
      } else ids.add(step.id);
    }
    if (step.dependsOn === undefined) return;
    if (!Array.isArray(step.dependsOn)) {
      errors.push({
        path: `/todo/${index}/dependsOn`,
        message: "Dependencies must be an array of earlier step numbers",
        value: step.dependsOn,
      });
      return;
    }
    const seen = new Set<number>();
    for (const dep of step.dependsOn) {
      if (typeof dep !== "number" || !Number.isInteger(dep) || dep < 1 || dep > index || seen.has(dep)) {
        errors.push({
          path: `/todo/${index}/dependsOn`,
          message: `Step ${index + 1} dependencies must be unique integer numbers of earlier steps (1–${index})`,
          value: dep,
        });
      }
      seen.add(dep);
    }
  });
  return errors;
}
