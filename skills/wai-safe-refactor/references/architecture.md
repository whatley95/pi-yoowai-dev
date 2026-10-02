# Responsibility and dependency boundaries

Name the behavior or maintenance problem that motivates a new boundary. Inspect its
callers and runtime ownership: who creates the resource, mutates the state, handles
failure, and disposes it. Keep dependencies directed and public contracts small.

Prefer an existing abstraction when it expresses the same contract. A new interface,
service, cache, or persistence layer needs a concrete use and lifecycle; don't add
layers solely to match a generic architecture pattern.

For moving code, check dynamic references, exports, configuration, and dependency
ownership as well as imports. Verify preservation through observable behavior and
integration boundaries. Document only decisions that help the next maintainer.
