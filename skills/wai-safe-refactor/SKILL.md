---
name: wai-safe-refactor
description: Refactor existing software while preserving behavior and compatibility. Use for moved responsibilities, renamed APIs, module splits, or dependency changes where callers and invariants need inspection.
license: MIT
---

# Refactor with preserved contracts

Name the intended structural improvement and the behavior that must remain stable.
Inspect the implementation, callers, exports, serialized/persisted shapes, lifecycle,
configuration, and integration tests relevant to the change. Use the code map/index
as navigation; verify important edges in source, especially in languages without an
AST dependency graph.

Work in cohesive changes that can be reviewed. Preserve public contracts and existing
user decisions unless changing them is part of the task. Avoid incidental dependency
upgrades, formatting churn, or parallel abstractions with no clear benefit.

Check dynamic/configuration references as well as static imports. For a rename/move,
search for the old name/path and distinguish legitimate compatibility references
from missed callers. Update relevant documentation and adapters together.

Use existing behavior/contract tests to verify preservation. Add a characterization
test only where an important invariant lacks evidence; do not create tests that merely
assert the new module layout. Report intentional behavior changes separately.
