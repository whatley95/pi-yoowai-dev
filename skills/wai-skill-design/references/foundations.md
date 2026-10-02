# Product interface foundations

Understand the primary action, user context, frequency of use, platform, and current
component system before changing an interface. Use existing spacing, colors, type,
radii, and motion tokens. Improve a concrete interaction instead of redesigning
unrelated surfaces.

## Structure and states

- Make hierarchy legible through grouping, spacing, size, weight, and contrast.
- Keep controls near the content they affect; use specific labels and clear wayfinding.
- Verify small and large layouts, long text, localization, and larger text settings.
- Account for loading, empty, success, validation, error, disabled, and retry states.
- Preserve useful information while data refreshes; avoid unexplained layout jumps.
- Give immediate feedback without delaying input or hiding an unfinished operation.
- Keep destructive actions recoverable where the product permits; follow the task's
  actual requirements for confirmations and undo.

## Accessible interaction

- Prefer semantic controls or the platform's accessible components. Include a
  meaningful accessible name and expose expanded, selected, disabled, and error states.
- Test keyboard activation and navigation, visible focus, focus restoration after
  overlays, dismissal, and interaction without a precise pointer.
- Check text/background contrast, touch targets, text scaling, and screen-reader order.
- Honor reduced motion. A static update or gentle opacity change can be correct;
  do not require a transform animation or a fade to satisfy the visual style.
- Never let decorative motion, stagger, or a transition block user interaction.

## Visual craft

Use weight, size, and line height together for type hierarchy. Validate tracking on
the actual font and language instead of applying one universal value. System fonts
are a useful default when the product has no established type choice.

Elevation can use subtle shadows, borders, or materials according to the existing
product. Blur/translucency must retain contrast and have an opaque fallback where
needed. Apple-style glass is an optional visual direction, not a requirement for
every interface.

Review in the running interface when possible. Code alone cannot establish whether
a spring, crossfade, spacing change, or gesture feels right on the target device.
