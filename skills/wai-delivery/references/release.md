# CI and release preparation

Inspect actual workflow triggers, matrix runtimes, dependency installation, artifacts,
and release commands. Verify the package includes its runtime sources and resources;
repository tests alone do not prove that the installed artifact works.

Keep local and CI commands consistent. Check environment/configuration precedence and
required values without logging secrets. Distinguish a local check from a completed
remote CI run, and report unavailable platform checks explicitly.

For a user-requested release or deployment, prepare a concrete tested artifact and
identify version, target, configuration, migration ordering, and recovery procedure
appropriate to that system. Follow existing authorization. Do not introduce a second
approval step where the user already authorized the operation.

For persisted data, establish backward/forward compatibility and failure handling.
A code rollback may not reverse a data migration; verify the actual recovery method
before claiming rollback is possible. Do not execute a production migration merely
because its source is under review.
