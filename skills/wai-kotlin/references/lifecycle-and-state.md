# Lifecycle and state

## Coroutine and Flow ownership

Choose a scope matching the work's lifetime: visible UI, destination/ViewModel,
application work, or durable background work. Keep blocking operations main-safe.
Propagate cancellation instead of converting CancellationException into a generic
failure. Prefer controllable dispatchers and schedulers in tests where timing matters.
See [Android coroutine guidance](https://developer.android.com/kotlin/coroutines/coroutines-best-practices).

Collect UI streams with lifecycle-aware APIs appropriate to the installed libraries,
such as repeatOnLifecycle for Views or collectAsStateWithLifecycle for Compose.
Account for collection stopping and restarting, repeated upstream work, and event
delivery while the UI is inactive. Do not assume launching a collector alone binds it
to visible UI. See [StateFlow and SharedFlow](https://developer.android.com/kotlin/flow/stateflow-and-sharedflow).

## Compose and Views

Keep composable rendering free of uncontrolled side effects. Choose effect keys for
the intended restart behavior; inspect cancellation, observer/resource disposal,
and values captured by long-lived effects. Recomposition itself is not a defect or
proof of a performance problem. For Views, respect the Fragment view lifecycle and
release bindings/listeners when that view is destroyed.
See [Compose effects](https://developer.android.com/develop/ui/compose/side-effects)
and [composable lifecycle](https://developer.android.com/develop/ui/compose/lifecycle).

## Restoration

A ViewModel can retain in-memory state across configuration changes but does not
survive system-initiated process death. Use the project's supported saved-state APIs
for small restoration inputs and persistent storage for durable application data.
Avoid serializing large payloads into saved state. Check navigation arguments,
restored destinations, in-progress input, and refetch behavior relevant to the task.
See [saving UI state](https://developer.android.com/topic/libraries/architecture/saving-states).

Exercise stop/start, navigation away and back, rotation, and recreation where they
affect the changed contract. Activity recreation alone does not establish actual
process-death restoration; disclose device scenarios that were not exercised.
