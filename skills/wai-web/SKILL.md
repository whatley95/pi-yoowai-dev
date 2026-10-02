---
name: wai-web
description: Implement or review browser application behavior, routing, forms, asynchronous UI state, or server rendering in React, Vue, Angular, Svelte, or another established web stack. Use existing framework conventions and versions; visual design is covered by wai-skill-design.
license: MIT
---

# Browser application behavior

Inspect the nearest package, framework/router versions, entry points, and existing
tests. Trace the requested behavior from URL or user action through state, requests,
rendering, and navigation. Preserve the chosen framework and rendering mode.

Keep state owned by the component, route, store, or server that defines its lifetime.
Derive values from existing state where possible. Treat effects as synchronization
with external systems; check dependencies, stale responses, cancellation, cleanup,
and repeated setup. Read [framework boundaries](references/frameworks.md) when
effects, SSR, hydration, or shared request state are affected.

For routing changes, test direct entry, refresh, back/forward, query parameters,
and the actual deployment base/rewrite behavior. Keep guard/loading/error behavior
consistent with the route contract. A browser guard is not server authorization.

For forms and asynchronous UI, verify validation, submission races, loading/error/
empty states, focus, keyboard access, and user-visible recovery relevant to the task.
Use existing browser tests for wiring risks; a mocked component test does not prove
deployed navigation or server rendering. Read [evaluation criteria](references/checks.md)
for review and report unverified browser/deployment behavior explicitly.
