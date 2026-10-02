# Measure before optimizing

Capture a reproducible workload and baseline: elapsed time, request count, bytes,
memory, or query counts that relate to the user's problem. Separate remote waiting,
local computation, repeated work, and concurrency before choosing an optimization.

Preserve the accuracy/completeness contract, cancellation, resource limits, and cache
invalidation. A lower workload, omitted evidence, or weaker verification is not the
same workload running faster. Count work avoided as well as time saved.

Validate behavior under failures and concurrent requests when they are affected.
Compare equivalent inputs and settings; report deterministic stub results separately
from live latency. Keep useful instrumentation bounded and free of sensitive data.
