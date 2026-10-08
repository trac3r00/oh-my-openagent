import { createHash } from "node:crypto"
import { z } from "zod"

export const DECISION_MODEL = "jev-1.13.0"
export const DEFAULT_TIMEOUT_MS = 1500
export const DEFAULT_THRESHOLD = 0.8
// Per-skill description cap for the request state; 0 disables it. Chosen from the 2026-10-04 cap
// benchmark: 8/8 labeled scenarios kept their expected suggestion at this depth for ~20% fewer tokens.
export const DEFAULT_DESCRIPTION_CAP = 220
export const JEV_URL = "https://api.typesafe.ai/v1/systemone"
export const CANDIDATE_GUIDANCE =
  "A skill matters only if consulting it would materially change how the task is done. " +
  "A mention or generic overlap is not enough. Judge each skill independently; " +
  "several, one, or no skills can be relevant."

export type PilotMode = "off" | "shadow" | "advisory" | "auto"
export interface SkillCandidate {
  name: string
  description: string
}
export interface Advice {
  status: "ok" | "skipped" | "failed"
  reason?: string
  durationMs: number
  decisionModel: string
  suggestions: string[]
  primary?: string
  scores: Array<{ skill: string; score: number }>
  usage?: { input_tokens: number; output_tokens: number }
  httpStatus?: number
}

const responseSchema = z.object({
  model: z.literal(DECISION_MODEL),
  answers: z.record(
    z.string(),
    z.object({
      type: z.literal("noul"),
      noul: z.number().min(0).max(1),
    }),
  ),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
})

const TRIVIAL_PROMPTS = new Set([
  "hi", "hello", "hey", "yo", "sup", "thanks", "thank you", "thx", "ty",
  "ok", "okay", "k", "yes", "yep", "no", "nope", "nice", "cool", "great",
  "done", "continue", "go on", "go ahead", "lgtm", "sure",
])

// Pure acknowledgements never need skill routing; skipping them saves a whole request (~6k tokens).
export function isTrivialPrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase().replace(/[!.…]+$/, "")
  return normalized.length <= 24 && TRIVIAL_PROMPTS.has(normalized)
}

// Word-boundary cut for the description sent to Jev; a short description or a disabled cap passes through.
function capDescription(text: string, cap: number): string {
  if (cap <= 0 || text.length <= cap) return text
  const cut = text.slice(0, cap)
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"))
  return `${(lastBreak > cap * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`
}

// One `id | name | description` line per skill means each description must be a single line.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export async function requestAdvice(options: {
  prompt: string
  candidates: SkillCandidate[]
  key: string | undefined
  mode: PilotMode
  signal: AbortSignal
  timeoutMs?: number
  threshold?: number
  descriptionCap?: number
  url?: string
}): Promise<Advice> {
  const started = performance.now()
  const result = (status: Advice["status"], reason?: string): Advice => ({
    status,
    ...(reason ? { reason } : {}),
    durationMs: performance.now() - started,
    decisionModel: DECISION_MODEL,
    suggestions: [],
    scores: [],
  })
  if (options.mode === "off") return result("skipped", "off")
  if (!options.key) return result("skipped", "missing_key")
  if (options.candidates.length === 0) return result("skipped", "no_skills")
  if (isTrivialPrompt(options.prompt)) return result("skipped", "trivial_prompt")

  // The shared rubric lives once in the state; per-question text stays minimal.
  // Measured against the shipped long-form design: same separation, ~21% fewer input tokens.
  // The short question below beat the long form on the 2026-10-04 benchmark: 8/8 scenarios kept
  // their expected suggestion with a higher mean score, at fewer tokens per skill.
  // Descriptions are capped so a long catalog description cannot dominate the request; the cap
  // benchmark kept the expected suggestion on 8/8 labeled scenarios at ~20% fewer tokens than none.
  // The state itself is compact (id | name | description lines): the JSON structural overhead cost
  // ~400 tokens per request on the live catalog, and the compact form measured equal accuracy at
  // ~9% fewer tokens (2026-10-04 bench 6: 8/8, mean 0.954 vs 0.951).
  const descriptionCap = options.descriptionCap ?? DEFAULT_DESCRIPTION_CAP
  const state = [
    `Task: ${options.prompt}`,
    `Rubric: ${CANDIDATE_GUIDANCE}`,
    "Skills (id | name | description):",
    ...options.candidates.map(
      (skill, index) => `s${index} | ${skill.name} | ${capDescription(oneLine(skill.description), descriptionCap)}`,
    ),
  ].join("\n")
  const body = JSON.stringify({
    model: DECISION_MODEL,
    state,
    questions: Object.fromEntries(
      options.candidates.map((_, index) => [
        `s${index}`,
        {
          type: "noul",
          instructions: `Does skill s${index} help this task?`,
        },
      ]),
    ),
  })
  // Conservative byte budgets, not an estimate of tokens or cache eligibility.
  if (Buffer.byteLength(state) > 24000 || Buffer.byteLength(body) > 48000) {
    return result("skipped", "input_too_large")
  }
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  ])
  try {
    const response = await fetch(options.url ?? JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.key}`, "Content-Type": "application/json" },
      body,
      signal,
    })
    if (!response.ok) return { ...result("failed", "http"), httpStatus: response.status }
    const parsed = responseSchema.safeParse(await response.json())
    if (!parsed.success) return result("failed", "invalid_response")
    const answers = parsed.data.answers
    const expectedIds = options.candidates.map((_, index) => `s${index}`)
    if (Object.keys(answers).length !== expectedIds.length || expectedIds.some((id) => answers[id] === undefined)) {
      return result("failed", "invalid_response")
    }
    const scores: Advice["scores"] = expectedIds.map((id, index) => ({
      skill: options.candidates[index]!.name,
      score: answers[id]!.noul,
    }))
    // Ranking comes free from the per-skill answers: no extra question needed.
    const cutoff = options.threshold ?? DEFAULT_THRESHOLD
    const ranked = [...scores].sort((left, right) => right.score - left.score)
    const suggestions = ranked.filter((entry) => entry.score >= cutoff).map((entry) => entry.skill)
    const primary = suggestions[0]
    return {
      ...result("ok"),
      scores,
      suggestions,
      ...(primary === undefined ? {} : { primary }),
      usage: parsed.data.usage,
    }
  } catch {
    return result(
      "failed",
      options.signal.aborted ? "cancelled" : signal.aborted ? "timeout" : "network_or_invalid_json",
    )
  }
}
