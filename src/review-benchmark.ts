export interface BenchmarkCase {
  id: string;
  before: string;
  after: string;
  defects: Array<{ id: string; description: string }>;
}

/** Small paired corpus: clean controls prevent "flag everything" from winning.
 * Human adjudication of findings is required; wording matches are not accuracy. */
export const BENCHMARK_CASES: BenchmarkCase[] = [
  {
    id: "bounds-bug",
    before: "export const last = (items) => items.at(-1);\n",
    after: "export const last = (items) => items[items.length];\n",
    defects: [
      {
        id: "off-by-one",
        description: "Indexes one past the final element, returning undefined for a nonempty array.",
      },
    ],
  },
  {
    id: "bounds-clean",
    before: "export const last = (items) => items.at(-1);\n",
    after: "export const last = (items) => items[items.length - 1];\n",
    defects: [],
  },
  {
    id: "async-bug",
    before: "export async function save(db, data) { await db.save(data); return { ok: true }; }\n",
    after: "export async function save(db, data) { db.save(data); return { ok: true }; }\n",
    defects: [
      {
        id: "missing-await",
        description: "Reports success before persistence finishes and does not propagate asynchronous rejection.",
      },
    ],
  },
  {
    id: "async-clean",
    before: "export async function save(db, data) { await db.save(data); return { ok: true }; }\n",
    after:
      "export async function save(db, data) { const result = await db.save(data); return { ok: true, result }; }\n",
    defects: [],
  },
  {
    id: "cache-bug",
    before: "export const key = (userId, locale) => JSON.stringify([userId, locale]);\n",
    after: "export const key = (userId, locale) => String(userId);\n",
    defects: [
      {
        id: "cache-collision",
        description: "Different locales for the same user share a key, mixing localized cached results.",
      },
    ],
  },
  {
    id: "cache-clean",
    before: "export const key = (userId, locale) => JSON.stringify([userId, locale]);\n",
    after: "export const key = (userId, locale) => JSON.stringify({ userId, locale });\n",
    defects: [],
  },
  {
    id: "escaping-bug",
    before: "export const text = (element, value) => { element.textContent = value; };\n",
    after: "export const text = (element, value) => { element.innerHTML = value; };\n",
    defects: [{ id: "html-injection", description: "Untrusted text becomes executable HTML instead of literal text." }],
  },
  {
    id: "escaping-clean",
    before: "export const text = (element, value) => { element.textContent = value; };\n",
    after: "export const text = (element, value) => { element.replaceChildren(document.createTextNode(value)); };\n",
    defects: [],
  },
];

export interface BenchmarkObservation {
  caseId: string;
  adjudicated: boolean;
  detectedDefectIds: string[];
  falsePositiveCount: number;
  elapsedMs: number;
  costUsd: number;
  error?: string;
}

export function scoreBenchmark(observations: BenchmarkObservation[]): {
  detected: number;
  missed: number;
  falsePositives: number;
  precision: number | null;
  recall: number;
  cleanCaseFalseAlarmRate: number;
  totalCostUsd: number;
  medianLatencyMs: number;
  failedCases: number;
} {
  if (!Array.isArray(observations) || observations.length !== BENCHMARK_CASES.length)
    throw new Error("Adjudicate every benchmark case exactly once.");
  const seen = new Set<string>();
  let detected = 0,
    missed = 0,
    falsePositives = 0,
    cleanFalseAlarms = 0,
    cleanCases = 0;
  for (const observation of observations) {
    const fixture = BENCHMARK_CASES.find((item) => item.id === observation.caseId);
    if (!fixture || seen.has(observation.caseId)) throw new Error("Unknown or duplicate benchmark case.");
    seen.add(observation.caseId);
    if (
      observation.adjudicated !== true ||
      !Array.isArray(observation.detectedDefectIds) ||
      !Number.isInteger(observation.falsePositiveCount) ||
      observation.falsePositiveCount < 0 ||
      !Number.isFinite(observation.elapsedMs) ||
      observation.elapsedMs < 0 ||
      !Number.isFinite(observation.costUsd) ||
      observation.costUsd < 0
    )
      throw new Error("Each case requires human adjudication and valid cost/latency measurements.");
    const ids = new Set(observation.detectedDefectIds);
    if (
      ids.size !== observation.detectedDefectIds.length ||
      [...ids].some((id) => !fixture.defects.some((defect) => defect.id === id))
    )
      throw new Error("Detected defect IDs must come from this case's rubric.");
    if (observation.error && ids.size) throw new Error("A failed review cannot claim detected defects.");
    detected += ids.size;
    missed += fixture.defects.length - ids.size;
    falsePositives += observation.falsePositiveCount;
    if (!fixture.defects.length) {
      cleanCases++;
      if (observation.falsePositiveCount > 0) cleanFalseAlarms++;
    }
  }
  const latencies = observations.map((item) => item.elapsedMs).sort((a, b) => a - b);
  return {
    detected,
    missed,
    falsePositives,
    precision: detected + falsePositives ? detected / (detected + falsePositives) : null,
    recall: detected / (detected + missed),
    cleanCaseFalseAlarmRate: cleanFalseAlarms / cleanCases,
    totalCostUsd: observations.reduce((sum, item) => sum + item.costUsd, 0),
    medianLatencyMs: (latencies[3] + latencies[4]) / 2,
    failedCases: observations.filter((item) => item.error).length,
  };
}
