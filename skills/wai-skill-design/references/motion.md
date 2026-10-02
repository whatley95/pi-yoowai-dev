# Motion decisions

Before implementing motion, establish its purpose: feedback, spatial continuity,
state indication, preventing a jarring transition, explanation, or occasional delight.
If it adds friction without helping the task, use an immediate state update.

Frequency is a restraint signal. Frequently repeated navigation and keyboard actions
should remain immediate; avoid blocking motion. Occasional overlays can use short
transitions, and rare onboarding/celebration can support more expressive motion when
requested. Do not assume a precise usage count from the component's name.

## Choose the existing tool first

Web: use CSS transitions for simple state changes, `@starting-style` where supported
for entry, WAAPI for programmatic control, and an existing motion library for gestures,
springs, exits, or layout coordination. Do not add a library for a simple fade.
Flutter: use existing implicit/explicit animation patterns, dispose controllers,
and respect the platform's reduced-animation preference.
Android: use the existing Compose or Views animation APIs; verify lifecycle and
system animation/accessibility settings with the target toolkit.

## Timing and curves

Use the project's tokens first. Useful starting ranges:

| Interaction              | Starting range                               |
| ------------------------ | -------------------------------------------- |
| Press feedback           | 100–160 ms                                   |
| Tooltip or small popover | 125–200 ms                                   |
| Dropdown or select       | 150–250 ms                                   |
| Modal or drawer          | 200–500 ms, depending on travel and platform |

Most small interactions benefit from less than 300 ms. Drawers, larger transitions,
springs, and explanatory motion can legitimately take longer; review responsiveness
and purpose instead of treating one duration as a universal defect.

Entrances/exits commonly use ease-out, movement between visible states ease-in-out,
hover/color changes ease, and constant motion linear. These are defaults, not bans on
established platform curves. Web reference values, when the project has no tokens:

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
```

## Continuity, accessibility, and performance

- Start anchored popovers near their trigger; centered modals need no trigger origin.
- Avoid an abrupt scale-from-zero entrance unless deliberately required. Small scale
  plus opacity or pure opacity are both valid choices.
- Rapidly re-triggered transitions should retarget from the current presentation.
  Gestures should preserve release velocity and remain interruptible.
- Prefer transform/opacity on the web. Layout, blur, clip-path, and library shorthand
  performance depends on rendering, version, browser, and device; profile meaningful
  risks rather than asserting that every CSS/WAAPI animation runs on the GPU.
- Gate hover-only behavior to suitable pointers. Provide reduced/static equivalents
  and never require movement when reduced motion is enabled.
- Keep group delays short (often 30–80 ms) when stagger helps; don't stagger every list.

Test repeated activation, reversal, exit, reduced motion, and low-powered devices when
available. Slow playback can expose discontinuities, but does not replace normal-speed
interaction. Distinguish measured performance from a suspected risk.
