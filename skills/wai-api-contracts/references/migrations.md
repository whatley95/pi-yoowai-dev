# Persisted contracts and migrations

Inspect the existing schema/migration system, deployed compatibility assumptions,
and readers/writers of the persisted shape. Identify whether old and new application
versions can coexist and which ordering makes each transition safe.

Use an additive transition where mixed versions require it: introduce the compatible
shape, migrate/backfill with observable progress, switch consumers, and remove old
fields only when that lifecycle permits. This is a decision pattern, not a requirement
to split every small migration into separate releases.

Check defaults/nullability, data conversion, idempotency, transaction/locking behavior,
interruption, and retry against the actual database and data volume relevant to the
task. Test representative old data and a failure or interrupted transition where
partial state is possible.

State what recovery can restore. A reversed schema declaration or code rollback does
not automatically recover transformed/deleted data. Prepare changes within the task;
run external migrations only under existing user authorization.
