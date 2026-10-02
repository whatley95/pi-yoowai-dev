---
name: wai-kotlin
description: Implement or review Kotlin Android apps, Jetpack Compose or XML UI, lifecycle-bound coroutines and Flow, platform integration, and mobile tests. Use for confirmed Android modules, including native Android code inside Flutter apps; Kotlin JVM servers do not imply Android.
license: MIT
---

# Kotlin and Android app development

Confirm the Android module, Gradle wrapper, plugin/version catalog, SDK levels,
manifest, build variants, existing UI toolkit, navigation, and tests. Preserve the
project's Compose or Views/XML approach, architecture, dependency injection, and
Java interoperability. Do not migrate frameworks or upgrade the toolchain as a
prerequisite for an unrelated feature.

Inspect Kotlin support in the installed Android Gradle plugin before adding plugins.
AGP can provide Kotlin itself; adding kotlin-android blindly can conflict with that
configuration. Read [build and testing](references/build-and-testing.md) for
toolchain changes, variant selection, or deciding which checks establish completion.

For coroutine/Flow, Compose effect, or state-restoration changes, read
[lifecycle and state](references/lifecycle-and-state.md). Match work to its owner,
keep blocking work off the main thread, preserve cancellation, and distinguish
configuration changes from system-initiated process death.

Follow the app's navigation/back/deep-link contracts and loading, empty, error,
offline, and retry states. Inspect manifest/component exposure, runtime permissions,
platform API guards, and storage/background-work behavior when the change touches
those boundaries. Do not add unrelated permissions or replace a working platform
integration with a preferred library.

Use Android semantics, text scaling, suitable touch/focus behavior, window insets,
and existing adaptive layouts. Verify animation/accessibility behavior on the actual
toolkit; CSS and Flutter recipes do not translate literally to Compose or Views.
Load wai-skill-design for relevant interaction intent when it is available.

For Flutter platform-channel work, inspect both the Dart caller and Android handler,
including payloads, errors, thread/lifecycle ownership, and disposal.

Read [evaluation criteria](references/checks.md) for reviews. Report actual wrapper,
variant, checks, and device/API evidence; a JVM test or successful compilation does
not establish Android UI, permission, process-restoration, or production integration
behavior.
