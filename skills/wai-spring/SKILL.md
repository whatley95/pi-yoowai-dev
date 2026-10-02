---
name: wai-spring
description: Implement or review Java/Spring service endpoints, persistence, transactions, configuration, or integration tests in a confirmed Spring project. Follow its actual framework version, build wrapper, and security conventions.
license: MIT
---

# Java/Spring work

Confirm the framework/build from pom, Gradle files, wrappers, source, and CI. Inspect
existing controllers, services, persistence, configuration, and tests before changing
boundaries. Use installed APIs; don't infer Spring version from a folder name.

Keep validation, DTO serialization, exception mapping, and service contracts aligned.
Review authorization/tenant checks at the effective boundary. Inspect transaction
ownership, rollback, lazy data access, retries/idempotency, and concurrent updates
where the change depends on them; don't widen transaction scope without cause.

Preserve environment-specific configuration and secret handling. Test with the right
level: unit, framework slice, or integration/database behavior. Mocks cannot prove
transaction semantics or actual database constraints. Use the project's wrapper and
targeted tests; report unavailable service/database checks explicitly.

Read [evaluation criteria](references/checks.md) for changed Java service code.
