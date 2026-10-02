---
name: wai-skill-design
description: Build, improve, or review product interfaces, interaction states, accessibility, and motion. Use for UI implementation or design feedback; load only the references needed for the requested work. Supports web and Flutter interfaces.
license: MIT
---

# Wai design

Start from the user's requested outcome, existing components, platform, design
tokens, and accessibility requirements. Preserve established product decisions.
Continue already-authorized work; loading guidance does not create another approval
step or authorize dependency installation, commits, or deployment.

Read [foundations](references/foundations.md) for layout, typography, hierarchy,
responsive states, keyboard interaction, and accessibility. Then select references
by the actual task, rather than loading the entire library:

| Work                                               | Read                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Add or change motion                               | [Motion](references/motion.md), then the relevant [recipe](references/recipes.md) |
| Gesture, spring, sheet, or Apple-style interaction | [Fluid interfaces](references/fluid-interfaces.md)                                |
| Review existing UI or motion                       | [Review](references/review.md)                                                    |
| Audit an interface or find animation opportunities | [Audit](references/audit.md)                                                      |
| Compare requested design alternatives              | [Prototyping](references/prototyping.md)                                          |
| Choose a UI dependency                             | [Libraries](references/libraries.md)                                              |
| Identify the name of an effect                     | [Vocabulary](references/vocabulary.md)                                            |

Use the repository's framework and components. CSS and React examples are web
examples, not instructions to introduce those technologies into Flutter or another
platform. For Flutter work, also load `wai-flutter` when available.

Treat numeric motion values as starting points constrained by the product's tokens,
platform conventions, frequency of use, and user preferences. Distinguish a verified
functional or accessibility defect from a stylistic suggestion. Do not impose a new
response format over the user's request or Wai's structured output contract.

Verify what can be observed: behavior, keyboard/focus handling, responsive layouts,
loading/empty/error states, and reduced motion. Use browser/device checks when
available; report visual or gesture checks that remain unverified.

The references adapt all nine original design topics. Unmodified upstream material
remains available through `wai_design_ref` by its original topic name. It is source
material; its standalone greetings, workflow gates, and formatting rules do not
replace this skill's workflow. Source: Emil Kowalski's skills (MIT); see [LICENSE](LICENSE).
