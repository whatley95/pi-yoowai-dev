# Design review

Judge the requested change against product requirements, existing tokens/components,
platform conventions, and visible evidence. A style preference is a suggestion unless
it violates an explicit requirement or produces a demonstrated usability defect.

Check the changed surface and its relevant neighbors:

- Interaction: immediate feedback, correct state changes, interruption/cancellation,
  coherent entry/exit, focus/dismissal, and no transition blocking input.
- Accessibility: semantic names/states, keyboard and screen-reader behavior, contrast,
  text scaling, touch targets, and reduced motion.
- Responsive states: small/large screens, loading, empty, error, retry, long content,
  and theme/localization behavior affected by the change.
- Motion: purpose and frequency, project timing/curves, origin where relevant,
  continuity under repeated activation, and appropriate static/reduced alternatives.
- Performance: observed jank or a specific rendering/lifecycle risk. Do not label all
  non-transform animation a defect without considering layout needs and evidence.

Pure fades can be correct. Drawers can legitimately exceed 300 ms. A reduced-motion
implementation can use an immediate update. Do not invent findings to satisfy a
preferred animation style or a required number of issues.

Cite the location, trigger, observed/expected behavior, and proportionate fix for
actionable findings. State unverified visual/device checks as limitations. Use the
requested report format; Wai's JSON contract remains authoritative for secondary
reviews. An optional before/after table is useful only when the requested format fits.

A code pass does not prove visual feel or complete the plan automatically. Apply Wai's
scope, coverage, verification, and step-completion rules to the actual task.
