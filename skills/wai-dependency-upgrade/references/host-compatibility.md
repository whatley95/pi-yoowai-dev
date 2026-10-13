# Host and SDK compatibility

Read this when an extension, plugin, or adapter must work across host versions.

- Separate the host's runtime API, installed SDK types, and any separately launched
  executable. Their versions can differ; evidence about one does not establish the others.
- Identify which layer owns authentication, model/catalog resolution, permissions,
  tool execution, cancellation, and lifecycle. Preserve that ownership during migration.
- Gate a new API with the host's documented capability or reliable version signal.
  A generic registration method does not prove support for a particular event or option.
  Handle missing optional features without claiming they ran.
- Keep legacy behavior reachable only for genuinely unsupported capabilities. A denied
  operation, disabled tool, authentication failure, or execution error on a supported
  API must not be disguised as an API absence or retried through a policy-bypassing path.
- Check startup, shutdown, session changes, in-flight work, and error cleanup when
  ownership moves to a host service. Avoid retaining objects from an outgoing session.
- Inspect streaming/event shapes and usage/error reporting as well as method signatures.
  Ensure an upgrade does not replay an already-started operation through another backend.
- Use actual supported host/SDK versions for integration evidence where available.
  Record which versions and paths ran; describe fixture-only coverage separately.
