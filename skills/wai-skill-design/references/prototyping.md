# Requested design alternatives

Use this workflow when the user asks to compare alternatives. An ordinary request to
implement a feature does not require building several variants or waiting for a pick.

Choose meaningfully different directions: layout, density, interaction, personality,
or motion. A few alternatives usually suffice; follow the requested scope/count.
Preserve the product's tokens and realistic surrounding content.

Build in a disposable, clearly scoped surface appropriate to the platform: a dev route,
storybook, standalone HTML, Flutter demo/screen, or existing preview harness. Avoid
introducing prototype imports/routes into production behavior without a reason.

A picker should support clear labels, keyboard/touch use, current selection, and full
size comparison in context. Adapt it to the framework instead of copying web markup
verbatim into every project. Switching should remain immediate; replay controls are
optional when there is motion worth replaying.

Verify each variant's actual behavior and console/runtime output. Show where to view
it and explain its tradeoff. When a choice is needed, wait for that choice; if the user
already selected a direction, implement it directly. Integrate the selected variant
using project conventions. Remove only prototype files created for this task, and
retain them if the user requested that.
