---
name: wai-dependency-upgrade
description: Upgrade libraries, frameworks, SDKs, or runtimes and migrate affected consumers while preserving supported behavior. Use for requested version upgrades or compatibility failures caused by a dependency change.
license: MIT
---

# Upgrade dependencies with compatibility evidence

Establish the installed/resolved version, declared range, requested target, package
manager, lockfile, and affected workspace. Inspect runtime and peer requirements,
supported host versions, and CI configuration. Distinguish the development version
from the oldest version the package promises to support. Do not assume the target is
latest or silently raise the supported minimum to make the migration easier.

Read installed types/source and official release or migration notes for the actual
current-to-target range. Check intermediate breaking releases when crossing majors.
Tie each relevant change to real callers, wrappers, configuration, exports, lifecycle,
or persisted data. Treat an unresolved API assumption as missing evidence; do not
copy an example for a different version or hide a missing capability with a cast.

For substantial upgrades, capture compatibility outcomes and completion checks in
the existing Wai plan. An analysis-only request produces an impact assessment;
installation and migration belong to an implementation request. Preserve the user's
chosen scope and existing authorization throughout the work.

Use the repository's package manager and workspace conventions to update the intended
dependency and required compatible peers. Inspect manifest and lockfile changes for
unexpected packages, registries, or unrelated churn. Resolve peer conflicts instead
of defaulting to force flags, blanket upgrades, or deleting the lockfile. Keep generated
dependency files consistent with their source declarations.

Migrate behavior as well as signatures: defaults, errors, asynchronous execution,
cancellation, ownership/cleanup, and configuration can change while code still compiles.
For plugins and SDK adapters that support multiple host versions, read
[host compatibility](references/host-compatibility.md).

Use the project's required checks and relevant integration paths to establish evidence.
When multiple versions remain supported, cover the oldest supported and target versions
where the changed APIs differ; a stub or mock alone does not prove host compatibility.
Keep unavailable environments or unexecuted checks explicitly unverified. A successful
install or typecheck alone does not establish runtime behavior.

Before completion, reconcile every identified breaking change with a migrated consumer,
an evidence-backed reason it is unaffected, or a remaining blocker. Report actual
before/after versions, supported-version changes, executed checks, and unresolved
compatibility. Update user-facing setup or migration guidance when usage changes.
