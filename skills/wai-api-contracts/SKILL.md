---
name: wai-api-contracts
description: Change or review an API, serialization boundary, authentication flow, or data migration affecting producers and consumers. Use when contract compatibility and failure behavior are part of the requested change.
license: MIT
---

# Contracts across boundaries

Locate the source of truth: schema, route/handler, serializer, shared model, or documented
protocol. Inspect the actual producers and consumers before deciding an edit order.
Respect repository-specific contracts and the user's compatibility requirements.

Keep request/response shapes, optional/default fields, enums, units, validation, and
error mapping consistent across affected layers. Preserve backward compatibility or
document an explicitly requested migration. Review versioned and persisted data as
well as current in-memory types.

For auth/data changes, inspect server-side authorization, ownership/tenant boundaries,
credential lifecycle, retries/idempotency, and sensitive logging as relevant. Do not
assume client visibility provides authorization or that a generic middleware covers
resource ownership.

Test the changed contract and concrete negative paths such as malformed payloads,
expired credentials, unavailable providers, or partial migration failures. Use the
repository's test fixtures and check commands. Don't introduce unrelated hardening
or a universal deployment gate into an ordinary change.

For review, read [evaluation criteria](references/checks.md). Report assumptions and
unverified integration behavior instead of manufacturing code findings.

For persisted schema changes or rolling-version compatibility, read
[data migrations](references/migrations.md).
