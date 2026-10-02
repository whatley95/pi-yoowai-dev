---
name: wai-node
description: Implement or review TypeScript/JavaScript Node.js modules, asynchronous services, package APIs, or integration tests in a confirmed Node project. Use its module system, runtime version, scripts, and existing tooling.
license: MIT
---

# TypeScript/Node work

Inspect package metadata, lockfile, runtime/CI versions, exports, tsconfig, and actual
scripts. Preserve ESM/CommonJS and NodeNext import conventions; don't invent a bundler
or compile step. Check public types and runtime behavior together.

Trace promise rejection, cancellation, timeout, resource/listener cleanup, and concurrent
state changes relevant to the change. Scope caches to their actual lifetime and invalidate
on changed inputs. Validate runtime inputs at boundaries rather than relying on types
alone, especially JSON/files/provider responses.

Preserve package exports and peer/runtime dependency ownership. Test observable contracts
using the project's runner, fixtures, and actual runtime; avoid tests tied solely to
private structure. Distinguish mocked provider tests from live compatibility evidence.

Read [evaluation criteria](references/checks.md) for affected JavaScript/TypeScript modules.
