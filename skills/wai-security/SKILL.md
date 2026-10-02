---
name: wai-security
description: Assess or fix a concrete software security boundary involving untrusted input, authorization, credentials, file or command access, or sensitive output. Use for requested hardening or security review and changes that alter these boundaries.
license: MIT
---

# Security at changed boundaries

Locate the affected input, principal, trusted operation, and output. Trace a reachable
path through validation and authorization before deciding whether a finding exists.
Respect established contracts; avoid expanding an ordinary change into a full audit.

Check resource ownership and tenant boundaries at the server, including negative
cases. Use structured query/command arguments and appropriate output encoding.
For file operations, inspect canonical containment, symlinks, and platform-specific
paths; lexical traversal checks alone do not establish containment. Consult
[boundary checks](references/boundaries.md) for the affected operation.

Keep credentials and sensitive payloads out of logs, fixtures, errors, and version
control. Use existing secret/configuration mechanisms. Check credential expiration,
refresh, and concurrent updates when they are part of the change. Do not rotate keys
or change external accounts just because this skill was selected.

Test the concrete exploit trigger or denied operation safely within existing fixtures.
Describe preconditions, source evidence, impact, and fix. Separate demonstrated defects
from uncertain assumptions; assess severity by reachability and consequence.
Read [evaluation criteria](references/checks.md) for review. A model verdict is not
proof of a live penetration test or complete security coverage.
