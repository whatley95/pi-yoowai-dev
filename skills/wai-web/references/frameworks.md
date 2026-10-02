# Framework and rendering boundaries

Use APIs supported by the installed version and existing architecture. Consult its
official documentation when a lifecycle or rendering contract is uncertain.

In React, calculate derived values during rendering when possible. Effects synchronize
external systems; clean up subscriptions and ignore or cancel superseded requests.
Repeated setup in development exposes missing cleanup rather than justifying a
global flag to suppress it. See [React effects](https://react.dev/learn/synchronizing-with-effects)
and [derived state](https://react.dev/learn/you-might-not-need-an-effect).

In Vue SSR, avoid mutable module singletons that leak one request's state to another.
Create request-local application/store state and check server/client output against
the same initial data. See [Vue SSR](https://vuejs.org/guide/scaling-up/ssr).

In Angular, inspect the configured per-route rendering strategy and hydration setup.
Direct DOM manipulation, inconsistent server/client markup, and browser-only assumptions
can break hydration. Preserve existing framework rendering contracts. See
[Angular hydration](https://angular.dev/guide/hydration) and
[rendering strategies](https://angular.dev/guide/routing/rendering-strategies).

For Svelte and other stacks, inspect their actual data-loading, reactive, and server/
client boundaries before applying rules from another framework. Do not convert the
application to a different state or rendering architecture as incidental cleanup.
