// allow: SIZE_OK - The approved pilot limits both launch and report controls to this single source file.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const MODES = ["off", "shadow", "advisory", "auto"] as const
type Mode = (typeof MODES)[number]
const SELECTION_TARGETS = ["task", "parent_read"] as const
type SelectionTarget = (typeof SELECTION_TARGETS)[number]

const nonnegative = z.number().nonnegative()
const count = z.int().nonnegative()
const base = {
  schemaVersion: z.literal(1),
  mode: z.enum(MODES),
  at: z.iso.datetime(),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
}
const eventSchema = z.discriminatedUnion("event", [
  z.looseObject({
    ...base, event: z.literal("turn_start"), promptHash: z.string(), catalogHash: z.string(), candidateCount: count,
    threshold: z.number().min(0).max(1).optional(), timeoutMs: count.optional(), descriptionCap: count.optional(), baselineRevision: z.string().optional(),
  }),
  z.looseObject({
    ...base, event: z.literal("advice"), status: z.enum(["ok", "skipped", "failed"]),
    reason: z.string().optional(), durationMs: nonnegative, suggestions: z.array(z.string()),
    primary: z.string().optional(),
    scores: z.array(z.object({ skill: z.string(), score: z.number() })),
    decisionModel: z.literal("jev-1.13.0"),
    usage: z.object({ input_tokens: count, output_tokens: count }).optional(),
    httpStatus: z.number().int().optional(),
  }),
  z.looseObject({
    ...base, event: z.literal("catalog"), beforeChars: count, afterChars: count,
    keptFull: z.array(z.string()), compacted: count, digestChars: count,
  }),
  z.looseObject({
    ...base, event: z.literal("skill_choice"), loadSkills: z.array(z.string()),
    selectionTarget: z.enum(SELECTION_TARGETS),
    category: z.string().optional(), subagentType: z.string().optional(),
  }),
  z.looseObject({
    ...base, event: z.literal("assistant"), provider: z.string().optional(),
    model: z.string().optional(), firstTextMs: nonnegative.nullable(),
    usage: z.object({
      input: count.optional(), output: count.optional(), cacheRead: count.optional(),
      cacheWrite: count.optional(), totalTokens: count.optional(),
    }).optional(),
  }),
  z.looseObject({ ...base, event: z.literal("turn_end"), durationMs: nonnegative, firstTextMs: nonnegative.nullable() }),
])
export type PilotEvent = z.infer<typeof eventSchema>

export function defaultLogDir(home = homedir()): string {
  return join(home, ".omo", "jev-pilot", "logs")
}

const ENV_FILE_NAMES = ["TYPESAFE_API_KEY", "OMO_JEV_PILOT_MODE", "OMO_JEV_PILOT_LOG_DIR", "OMO_JEV_PILOT_TIMEOUT_MS", "OMO_JEV_PILOT_THRESHOLD", "OMO_JEV_PILOT_DESCRIPTION_CAP"] as const

export function defaultEnvFile(home = homedir()): string {
  return join(home, ".omo", "jev-pilot", ".env")
}

export function parseEnvFile(text: string): { values: Record<string, string>; ignoredNames: string[] } {
  const values: Record<string, string> = {}
  const ignoredNames: string[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim().replace(/^export /, "")
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    let value = line.slice(separator + 1).trim()
    const quote = value[0]
    if (value.length >= 2 && (quote === '"' || quote === "'") && value[value.length - 1] === quote) value = value.slice(1, -1)
    if ((ENV_FILE_NAMES as readonly string[]).includes(name)) values[name] = value
    else if (!ignoredNames.includes(name)) ignoredNames.push(name)
  }
  return { values, ignoredNames }
}

// The file fills variables that are unset or empty, so a non-empty shell export always wins.
export function loadEnvFile(path: string): { values: Record<string, string>; ignoredNames: string[]; permissive: boolean } {
  if (!existsSync(path)) return { values: {}, ignoredNames: [], permissive: false }
  const parsed = parseEnvFile(readFileSync(path, "utf-8"))
  const mode = statSync(path).mode & 0o777
  return { ...parsed, permissive: process.platform !== "win32" && (mode & 0o077) !== 0 }
}

function applyEnvFile(path: string): void {
  const loaded = loadEnvFile(path)
  for (const [name, value] of Object.entries(loaded.values)) {
    // An empty exported variable counts as unset, so a stale `TYPESAFE_API_KEY=` cannot shadow the file.
    if (process.env[name] === undefined || process.env[name] === "") process.env[name] = value
  }
  if (loaded.ignoredNames.length > 0) process.stderr.write(`jev-pilot: ignored non-pilot entries in ${path}: ${loaded.ignoredNames.join(", ")}\n`)
  if (loaded.permissive) process.stderr.write(`jev-pilot: ${path} is readable by other users; run chmod 600 ${path}\n`)
}

export function parsePilotArgs(args: readonly string[], envMode?: string): { readonly command: "launch" | "report"; readonly mode: Mode; readonly logDir?: string; readonly passthrough: readonly string[] } {
  const [command, ...rest] = args
  if (command !== "launch" && command !== "report") throw new Error("Usage: bun script/jev-pilot.ts launch [--mode off|shadow|advisory|auto] [--log-dir PATH] -- [OmO args] | report [--log-dir PATH]")
  let mode: Mode | undefined
  let logDir: string | undefined
  let i = 0
  for (; i < rest.length; i++) {
    const flag = rest[i]
    if (command === "launch" && flag === "--") { i++; break }
    if (flag === "--mode" && command === "launch") {
      const value = rest[++i]
      if (value !== "off" && value !== "shadow" && value !== "advisory" && value !== "auto") throw new Error("--mode must be off, shadow, advisory or auto")
      mode = value
    } else if (flag === "--log-dir") {
      logDir = rest[++i]
      if (!logDir || logDir.startsWith("--")) throw new Error("--log-dir requires a directory path")
    } else {
      throw new Error("Unknown pilot option; use -- before OmO arguments")
    }
  }
  const passthrough = rest.slice(i)
  if (command === "launch" && passthrough.some((arg) => arg === "-e" || arg === "--extension" || arg.startsWith("--extension="))) {
    throw new Error("Pilot owns extension loading; remove -e/--extension from forwarded OmO arguments")
  }
  if (command === "launch" && mode === undefined && envMode !== undefined) {
    if (envMode !== "off" && envMode !== "shadow" && envMode !== "advisory" && envMode !== "auto") throw new Error("OMO_JEV_PILOT_MODE must be off, shadow, advisory or auto")
    mode = envMode
  }
  return { command, mode: mode ?? "shadow", ...(logDir === undefined ? {} : { logDir }), passthrough }
}

export function launchSpec(options: { readonly mode: Mode; readonly logDir?: string; readonly passthrough: readonly string[] }, env: NodeJS.ProcessEnv = process.env, root = resolve(dirname(fileURLToPath(import.meta.url)), "..")): { readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv } {
  const launcher = join(root, "packages", "omo-native", "bin", "omo.js")
  const extension = join(root, "packages", "omo-native", "plugin", "extensions", "omo.js")
  if (!existsSync(launcher)) throw new Error(`Fork launcher missing: ${launcher}; check the pilot worktree`)
  if (!existsSync(extension)) throw new Error(`Pilot extension missing: ${extension}; build the fork plugin before launching`)
  return {
    // The native wrapper prepends this worktree's packaged plugin exactly once.
    // --no-extensions disables discovery of the user's installed extensions.
    argv: [process.execPath, launcher, "--no-extensions", ...options.passthrough],
    env: {
      ...env, OMO_DEV: "1", OMO_JEV_PILOT_MODE: options.mode,
      OMO_JEV_PILOT_BASELINE_REVISION: "2afeed86cfbcc0de250321955589e905bcdc0acc",
      OMO_JEV_PILOT_LOG_DIR: resolve(options.logDir ?? env.OMO_JEV_PILOT_LOG_DIR ?? defaultLogDir()),
    },
  }
}

export async function runLaunch(spec: ReturnType<typeof launchSpec>, spawn: typeof Bun.spawn = Bun.spawn): Promise<number> {
  const child = spawn([...spec.argv], { env: spec.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  let forwarded: NodeJS.Signals | null = null
  const forward = (signal: NodeJS.Signals) => {
    forwarded = signal
    child.kill(signal)
  }
  const onInt = () => forward("SIGINT")
  const onTerm = () => forward("SIGTERM")
  const onHup = () => forward("SIGHUP")
  process.on("SIGINT", onInt)
  process.on("SIGTERM", onTerm)
  process.on("SIGHUP", onHup)
  let exitCode: number
  try {
    exitCode = await child.exited
  } finally {
    process.off("SIGINT", onInt)
    process.off("SIGTERM", onTerm)
    process.off("SIGHUP", onHup)
  }
  const signal = forwarded ?? child.signalCode
  if (signal) process.kill(process.pid, signal)
  return exitCode
}

export async function readPilotLogs(logDir: string): Promise<PilotEvent[]> {
  if (!existsSync(logDir)) return []
  const events: PilotEvent[] = []
  for (const entry of readdirSync(logDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
    const file = join(logDir, entry.name)
    const lines = (await Bun.file(file).text()).split("\n")
    for (const [index, line] of lines.entries()) {
      if (line === "" && index === lines.length - 1) continue
      if (line.trim() === "") throw new Error(`Malformed JSONL: ${file}:${index + 1} (empty record; contents withheld)`)
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`Malformed JSONL: ${file}:${index + 1} (invalid JSON; contents withheld)`)
      }
      const parsed = eventSchema.safeParse(value)
      if (!parsed.success) throw new Error(`Malformed JSONL: ${file}:${index + 1} (invalid pilot event; contents withheld)`)
      events.push(parsed.data)
    }
  }
  return events
}

type Field = { samples: number; sum: number | null }
type Latency = { samples: number; total: number; medianMs: number | null; p95Ms: number | null }
const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const

function latency(values: number[], total: number): Latency {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p: number): number | null => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] ?? null : null
  return { samples: values.length, total, medianMs: percentile(0.5), p95Ms: percentile(0.95) }
}

// Percentile view for percentage metrics (cache-hit rates), mirroring the latency shape.
function percentiles(values: number[]): { samples: number; median: number | null; p95: number | null } {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (p: number): number | null => (sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] ?? null : null)
  return { samples: sorted.length, median: at(0.5), p95: at(0.95) }
}

// Cache-hit percentage: cached reads over all prompt-side tokens. Null when nothing was observed.
function cacheHitPercent(cacheRead: number | null, input: number | null): number | null {
  if (cacheRead === null || input === null || cacheRead + input === 0) return null
  return Number(((cacheRead / (cacheRead + input)) * 100).toFixed(1))
}

function fields(keys: readonly string[]): Record<string, Field> {
  return Object.fromEntries(keys.map((key) => [key, { samples: 0, sum: null }]))
}

function addField(target: Field, value: number | undefined): void {
  if (value === undefined) return
  target.samples++
  target.sum = (target.sum ?? 0) + value
}

// Published Jev rate: $42 per billion input tokens (output tokens are free).
const JEV_USD_PER_BILLION_INPUT_TOKENS = 42

export function summarize(events: readonly PilotEvent[]): Record<Mode, unknown> {
  const result: Record<Mode, unknown> = { off: null, shadow: null, advisory: null, auto: null }
  for (const mode of MODES) {
    const records = events.filter((event) => event.mode === mode)
    const sessions = new Set(records.map((event) => event.sessionId))
    const turns = new Map<string, { suggestions?: Set<string>; choices: Partial<Record<SelectionTarget, Set<string>>> }>()
    const requestDuration: number[] = []
    const turnDuration: number[] = []
    const firstText: number[] = []
    const requests = { ok: 0, skipped: 0, failed: 0, noSuggestions: 0 }
    const adviceTokens = fields(["input_tokens", "output_tokens"])
    const assistantTokens = fields(usageKeys)
    const models: Record<string, { assistantEvents: number; tokens: Record<string, Field> }> = {}
    const chosenSkills: Record<SelectionTarget, Record<string, number>> = { task: {}, parent_read: {} }
    const primarySkills: Record<string, number> = {}
    const catalog = { events: 0, beforeChars: 0, afterChars: 0, savedChars: 0, compacted: 0, digestChars: 0 }
    // The final observed request per session carries the dashboard-style "CH last" reading.
    const sessionTails = new Map<string, { input: number; cacheRead: number }>()
    let assistantEvents = 0
    let providerCoverage = 0
    let modelCoverage = 0
    let ends = 0
    for (const event of records) {
      const key = JSON.stringify([event.sessionId, event.turnId])
      const turn = turns.get(key) ?? { choices: {} }
      turns.set(key, turn)
      switch (event.event) {
        case "turn_start": break
        case "advice":
          requests[event.status]++
          requestDuration.push(event.durationMs)
          if (event.status === "ok") {
            turn.suggestions = new Set([...(turn.suggestions ?? []), ...event.suggestions])
            if (event.suggestions.length === 0) requests.noSuggestions++
          }
          {
            const primary = (event as unknown as { primary?: unknown }).primary
            if (typeof primary === "string") primarySkills[primary] = (primarySkills[primary] ?? 0) + 1
          }
          addField(adviceTokens.input_tokens, event.usage?.input_tokens)
          addField(adviceTokens.output_tokens, event.usage?.output_tokens)
          break
        case "catalog":
          catalog.events++
          catalog.beforeChars += event.beforeChars
          catalog.afterChars += event.afterChars
          catalog.savedChars += Math.max(0, event.beforeChars - event.afterChars)
          catalog.compacted += event.compacted
          catalog.digestChars += event.digestChars
          break
        case "skill_choice":
          turn.choices[event.selectionTarget] = new Set([...(turn.choices[event.selectionTarget] ?? []), ...event.loadSkills])
          for (const skill of event.loadSkills) {
            const counts = chosenSkills[event.selectionTarget]
            counts[skill] = (counts[skill] ?? 0) + 1
          }
          break
        case "assistant": {
          assistantEvents++
          if (event.provider !== undefined) providerCoverage++
          if (event.model !== undefined) modelCoverage++
          const name = `${event.provider ?? "(unknown)"}/${event.model ?? "(unknown)"}`
          const model = models[name] ??= { assistantEvents: 0, tokens: fields(usageKeys) }
          model.assistantEvents++
          for (const field of usageKeys) {
            addField(assistantTokens[field], event.usage?.[field])
            addField(model.tokens[field], event.usage?.[field])
          }
          if (event.usage !== undefined && (event.usage.input !== undefined || event.usage.cacheRead !== undefined)) {
            sessionTails.set(event.sessionId, { input: event.usage.input ?? 0, cacheRead: event.usage.cacheRead ?? 0 })
          }
          break
        }
        case "turn_end":
          ends++
          turnDuration.push(event.durationMs)
          if (event.firstTextMs !== null) firstText.push(event.firstTextMs)
          break
        default: {
          const exhaustive: never = event
          throw new Error(`Unhandled event: ${exhaustive}`)
        }
      }
    }
    const overlap = {
      task: { comparableTurns: 0, overlapTurns: 0, suggestedNames: 0, overlappingNames: 0 },
      parent_read: { comparableTurns: 0, overlapTurns: 0, suggestedNames: 0, overlappingNames: 0 },
    }
    for (const turn of turns.values()) {
      if (!turn.suggestions) continue
      for (const target of SELECTION_TARGETS) {
        const choices = turn.choices[target]
        if (!choices) continue
        const metric = overlap[target]
        metric.comparableTurns++
        metric.suggestedNames += turn.suggestions.size
        const matches = [...turn.suggestions].filter((skill) => choices.has(skill)).length
        metric.overlappingNames += matches
        if (matches > 0) metric.overlapTurns++
      }
    }
    const lastPercents = [...sessionTails.values()]
      .map((tail) => cacheHitPercent(tail.cacheRead, tail.input))
      .filter((value): value is number => value !== null)
    result[mode] = {
      sessions: sessions.size, turns: turns.size, requests,
      suggestionChoiceOverlap: { byTarget: overlap, interpretation: "overlap, not correctness" },
      chosenSkills, primarySkills, durationMs: { request: latency(requestDuration, records.filter((e) => e.event === "advice").length), turn: latency(turnDuration, turns.size) },
      estimatedAdviceCostUsd: adviceTokens.input_tokens.sum === null ? null : Number(((adviceTokens.input_tokens.sum * JEV_USD_PER_BILLION_INPUT_TOKENS) / 1_000_000_000).toFixed(6)),
      firstTextMs: latency(firstText, ends),
      catalog,
      cacheHit: {
        lastRequests: percentiles(lastPercents),
        sessionPercent: cacheHitPercent(assistantTokens.cacheRead.sum, assistantTokens.input.sum),
        sums: { input: assistantTokens.input.sum, cacheRead: assistantTokens.cacheRead.sum, cacheWrite: assistantTokens.cacheWrite.sum },
      },
      reported: { adviceTokens, assistantEvents, providerCoverage, modelCoverage, assistantTokens, models },
    }
  }
  return result
}

async function main(): Promise<void> {
  try {
    applyEnvFile(process.env.OMO_JEV_PILOT_ENV_FILE ?? defaultEnvFile())
    const options = parsePilotArgs(process.argv.slice(2), process.env.OMO_JEV_PILOT_MODE)
    if (options.command === "launch") {
      process.exitCode = await runLaunch(launchSpec(options))
    } else {
      const logDir = resolve(options.logDir ?? process.env.OMO_JEV_PILOT_LOG_DIR ?? defaultLogDir())
      process.stdout.write(`${JSON.stringify(summarize(await readPilotLogs(logDir)), null, 2)}\n`)
    }
  } catch (error) {
    process.stderr.write(`jev-pilot: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
