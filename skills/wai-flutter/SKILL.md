---
name: wai-flutter
description: Implement or review Flutter/Dart widgets, navigation, asynchronous UI state, or mobile integration tests in a confirmed Flutter project. Use the installed Flutter version and existing state-management/navigation choices.
license: MIT
---

# Flutter work

Confirm the Flutter SDK dependency and inspect pubspec, existing widgets, routing,
state-management patterns, tests, and CI. Reuse project choices rather than replacing
them with a preferred package. Verify unfamiliar APIs against the installed version.

Check mounted/lifecycle behavior across async boundaries, ownership/disposal of
controllers, subscriptions and timers, navigation/deep links, and restoration/state
behavior affected by the change. Keep loading/error/empty/retry states explicit.

Use semantic accessible widgets, platform-appropriate focus/touch targets, text
scaling, and the platform's reduced-animation preference. Design references can guide
interaction intent; CSS/React recipes do not apply literally to Dart widgets.

Choose unit, widget, integration, or device checks based on the changed contract.
Discover actual analyze/test commands from the project. `flutter test` alone does
not prove platform channels, production backend behavior, or physical-device gestures.

Read [evaluation criteria](references/checks.md) when reviewing affected Dart UI.
