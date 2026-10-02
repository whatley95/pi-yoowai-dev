# Browser and integration evidence

Choose a real browser check when URL handling, rendering, event wiring, or a user flow
is the risk. Reuse the installed runner and fixtures. Prefer role, label, or stable
product test identifiers over DOM structure or timing assumptions. Wait for observable
state with the runner's assertions rather than fixed sleeps.

Keep tests independent, with isolated sessions and controlled seed data. Exercise
direct entry/refresh and back/forward when routing changes; check loading, failure,
and accessible interaction paths relevant to the contract. Mock external services
where appropriate, and state which real integration remains unverified.

For a failure, preserve the first failing assertion and useful trace, screenshot,
network, or console evidence. Investigate shared state and races before increasing
timeouts or retry counts. A retry pass does not explain the original failure.

For service/database integration, check real adapter configuration, serialization,
transaction/error behavior, and cleanup in disposable fixtures. Unit tests of a
mock adapter do not establish the production adapter contract.

See [Playwright practices](https://playwright.dev/docs/best-practices),
[locators](https://playwright.dev/docs/locators), and
[failure traces](https://playwright.dev/docs/trace-viewer) when that runner is installed.
