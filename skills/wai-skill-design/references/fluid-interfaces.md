# Fluid interfaces

Adapted from the Apple-style guidance in the vendored design material. Apply the
interaction principles to the actual platform; do not import web libraries into a
native application merely to reproduce a code example.

Direct manipulation should track the pointer/finger with its grab offset. Show
press feedback immediately while committing the action through the normal activation
semantics. Track pointer identity, capture, cancellation, and recent velocity.

An interrupted gesture should resume from the current on-screen value. Springs can
carry velocity through retargeting; a new animation from an old logical endpoint can
produce a visible jump. Keep input available during transitions.

Start with critically damped or low-bounce motion for ordinary UI. Add overshoot only
when it supports the interaction's momentum or established personality. In a compatible
Motion API, examples include `{ type: "spring", bounce: 0, duration: 0.4 }` or a small
bounce around `0.2`; verify the installed API and existing project parameters.

For snapping after drag, project the landing point from current position and recent
velocity rather than picking solely from the release position. One exponential-decay
reference is `(velocityPxPerSecond / 1000) * d / (1 - d)`, with `d` near `0.998`.
Use platform/library behavior when available; check units, bounds, and zero-distance
cases instead of copying physics parameters blindly.

Use progressive resistance beyond a boundary and coherent entry/exit paths. Test
reversal, re-grabbing, fast flicks, long drags, cancellation, and multiple pointers.

Translucent materials, depth, and optical typography are optional stylistic tools.
Verify contrast over moving backgrounds, larger text, light/dark themes, and reduced
transparency. Honor reduced motion with static or gentle opacity alternatives.
Haptics/audio, where supported and requested, should reinforce meaningful feedback
without repeated noise or perceptible lag.
