# Focus on the affected trust boundary

- Database/command operations: use parameterized APIs or argument arrays, inspect
  interpreter/evaluation behavior, and validate domain values rather than escaping
  an already constructed command string.
- File operations: resolve against the permitted root and inspect canonical ancestors
  before following symlinks/junctions, including newly created descendants. Preserve
  host policy enforcement for every access, including cached evidence.
- Browser output: use framework escaping and encoding appropriate to the destination.
  Raw HTML needs a supported sanitizer and an explicit contract. Encoding for one
  context does not make data safe in another. See
  [OWASP XSS guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html).
- Credentials: inspect storage, logging, access scope, expiration, and refresh races
  relevant to the task. Follow the project's secret mechanism; do not copy production
  secrets into examples or tests. See
  [OWASP secret management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).
- Dependencies: establish the installed version and a relevant advisory before claiming
  vulnerability. Preserve lockfiles and compatibility checks when updating dependencies.

Choose checks proportional to the actual changed boundary. A missing general defense
is not automatically a reachable defect in this patch.
