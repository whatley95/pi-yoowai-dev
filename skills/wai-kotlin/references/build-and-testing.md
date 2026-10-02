# Build and mobile verification

Inspect the repository's Gradle wrapper, JDK, Android Gradle plugin, Kotlin/Compose
configuration, SDK levels, version catalogs, and CI before changing build files.
Use installed versions and existing flavors/build types; do not prescribe a latest
version upgrade as part of an ordinary app change.

AGP 9.0 introduced built-in Kotlin enabled by default for Android modules. Check
the actual plugin version and opt-out/module configuration before recommending the
separate kotlin-android plugin. Kotlin Multiplatform has distinct plugin requirements;
do not remove its Kotlin plugin merely because Android supports built-in Kotlin.
Verify annotation processing and compiler configuration when a migration is actually
requested. See [built-in Kotlin migration](https://developer.android.com/build/migrate-to-built-in-kotlin).

Select relevant checks from existing Gradle tasks and CI. Common task shapes include
test<Variant>UnitTest, lint<Variant>, and connected<Variant>AndroidTest, scoped to the
actual module; their names and availability depend on the project. Use gradlew.bat
on Windows where appropriate. Record SDK/emulator/device availability rather than
inventing a passing command.

Local JVM tests can verify state transitions, contracts, and controlled coroutine
behavior. Instrumented tests exercise Android behavior on a physical or emulated
device; UI checks should use the existing Compose/Espresso harness. Neither kind
proves production service behavior when providers are mocked.
See [Android testing fundamentals](https://developer.android.com/training/testing/fundamentals).

Exercise relevant API levels, permissions, lifecycle transitions, text scaling,
insets, adaptive layouts, and navigation behavior. Run only checks warranted by the
change and required by the repository. An assemble success proves compilation and
packaging, not all runtime behavior. Preserve release signing and sensitive build
configuration; publishing remains a separately authorized action.
