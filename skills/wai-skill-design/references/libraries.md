# UI library selection

Inspect the framework, manifest, existing components, license/runtime constraints,
bundle/performance needs, and installed versions before recommending a dependency.
Reuse a suitable existing solution. Verify unfamiliar/current APIs in official docs.
Do not replace the user's chosen library or install an alternative without task scope
or authorization supporting that action.

The original curated web list is a starting reference, not a universal prescription:

| Need                        | Web/React examples to evaluate                                       |
| --------------------------- | -------------------------------------------------------------------- |
| Accessible primitives       | Base UI or the project's existing primitives                         |
| Command menu, toasts, OTP   | cmdk, Sonner, input-otp                                              |
| Springs/exits/layout        | Motion; CSS/WAAPI for simpler transitions                            |
| Animated values/text        | NumberFlow, torph                                                    |
| Charts                      | Recharts; evaluate Liveline for live/streaming data                  |
| Drag/drop, virtualization   | dnd kit, Virtuoso                                                    |
| Shared state                | Existing framework state; Zustand where appropriate                  |
| Conditional/variant classes | clsx, cva where their added value is concrete                        |
| Theme switching             | Existing framework theme support; next-themes in compatible projects |
| Specialized visuals/tooling | Cobe, Satori, Shiki, Leva/dialkit where the task needs them          |

These examples do not imply suitability or current compatibility for every version.
Flutter should start with its existing Material/Cupertino/widgets and approved package
stack; other frameworks use their own compatible solutions. Recommend based on the
actual requirement rather than substituting a React preference for a native task.

Explain the concrete benefit and costs: accessible behavior, maintenance, integration,
bundle/runtime impact, and migration. A custom component is not automatically a defect;
verify its behavior before recommending replacement.
