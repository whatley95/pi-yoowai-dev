# Motion recipes

Use the existing component and motion APIs; these are ingredients, not complete
accessible components. Read the relevant section and include keyboard, lifecycle,
exit, and reduced-motion behavior alongside visual implementation.

## Press feedback

Small scale (about 0.95–0.98) or color/elevation feedback over 100–160 ms. Preserve
the pointer-down feedback and keyboard activation. Use static/color feedback for
reduced motion; the product's existing button behavior takes precedence.

## Popover, dropdown, and tooltip

Prefer established primitives with focus/dismissal handling. Use short opacity or
small-scale entry, with origin at the trigger if scaling. Tooltips can retain their
first-hover delay and appear immediately on adjacent targets in an open tooltip group.

## Modal, drawer, and toast

Centered modals can fade/scale from the center. Drawers commonly translate by their
own extent and can take 200–500 ms; toasts should enter/exit coherently without
blocking clicks. Handle repeated triggers and interrupted exits. Preserve the
component's focus, stacking, timer, and dismissal behavior.

## Accordion and changing layout

Height animation can be appropriate when content must participate in layout. Do not
replace it with a transform that overlaps neighboring content. Measure dynamic
content, retarget on changes, and verify the reduced-motion/static state.

## Stagger and scroll reveal

If a group entrance helps, use short delays (about 30–80 ms) and keep interaction
available. Never leave content hidden when script/observation fails. Avoid repeating
reveals on frequently used surfaces; preserve a static reduced-motion version.

## Hold to confirm

A progress fill can represent deliberate holding (for example, two seconds), with
a quick cancellation/reset. Visual CSS is not the confirmation logic: implement
completion, cancellation, keyboard/device equivalents, and the actual destructive
action according to the product's requirements.

## Tabs and shared elements

Use the existing indicator/layout animation. Clip-based overlays can improve color
continuity on the web, but duplicated visual markup must not create duplicate
accessible controls. Preserve selected state, keyboard order, and focus.

## Drag to dismiss

Track pointer identity, capture/cancel behavior, position, and recent velocity. A
flick threshold must fit the platform and units; do not copy a universal numerical
threshold. Combine distance/velocity intent, spring handoff, soft boundaries, and
multi-touch protection. Verify on a physical device when possible.

## Crossfade and programmatic motion

Opacity transitions can be sufficient. A small blur can mask a difficult crossfade
when it suits the product and performs adequately; it is not an obligatory fix.
WAAPI provides cancellation/control on the web. Clean up animation handles and
listeners, and avoid leaving fill styles or controllers alive after disposal.
