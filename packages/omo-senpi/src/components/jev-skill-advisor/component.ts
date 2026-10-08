import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import type { OmoSenpiComponent } from "../../extension/types"
import {
  buildSkillDigest,
  extractSkillRoots,
  findSkillLocation,
  pruneSkillCatalog,
  resolveSkillFile,
} from "./catalog"
import { DEFAULT_DESCRIPTION_CAP, DEFAULT_THRESHOLD, DEFAULT_TIMEOUT_MS, digest, requestAdvice, type PilotMode, type SkillCandidate } from "./decision"
import { createTelemetry } from "./telemetry"

const KEEP_FULL_SHORTLIST = 5
const DIGEST_MAX_CHARS = 1200

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const modeSchema = z.enum(["off", "shadow", "advisory", "auto"])
const startSchema = z.object({ prompt: z.string(), systemPrompt: z.string().optional() })
const inputSchema = z.object({ source: z.enum(["interactive", "rpc", "extension"]) })
const updateSchema = z.object({ assistantMessageEvent: z.object({ type: z.literal("text_delta"), delta: z.string() }) })
const usageSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
})
const messageSchema = z.object({
  message: z.object({
    role: z.literal("assistant"),
    provider: z.string().optional(),
    model: z.string().optional(),
    usage: usageSchema.optional(),
  }),
})
const taskSchema = z.object({
  toolName: z.literal("task"),
  input: z.object({
    load_skills: z.array(z.string()).optional(),
    category: z.string().optional(),
    subagent_type: z.string().optional(),
  }),
})
const readSchema = z.object({ toolName: z.literal("read"), input: z.object({ path: z.string() }) })

export function createJevSkillAdvisorComponent(): OmoSenpiComponent {
  return {
    name: "jev-skill-advisor",
    register(pi, ctx) {
      const modeValue = modeSchema.safeParse(process.env.OMO_JEV_PILOT_MODE)
      const directory = process.env.OMO_JEV_PILOT_LOG_DIR
      if (!modeValue.success || !directory) return
      const mode: PilotMode = modeValue.data
      const timeoutMs = z.coerce.number().int().min(1).max(10000).catch(DEFAULT_TIMEOUT_MS).parse(process.env.OMO_JEV_PILOT_TIMEOUT_MS)
      const threshold = z.coerce.number().min(0).max(1).catch(DEFAULT_THRESHOLD).parse(process.env.OMO_JEV_PILOT_THRESHOLD)
      // 0 disables the cap; an empty value counts as unset so the default applies.
      const descriptionCap = z.coerce.number().int().min(0).max(4000).catch(DEFAULT_DESCRIPTION_CAP).parse(process.env.OMO_JEV_PILOT_DESCRIPTION_CAP || undefined)
      const endpoint = process.env.OMO_JEV_PILOT_URL
      if (endpoint && (!URL.canParse(endpoint) || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname))) {
        throw new Error("OMO_JEV_PILOT_URL is only supported for loopback QA fixtures")
      }
      const telemetry = createTelemetry(directory, () => ctx.logger.warn("[Jev pilot] Could not append comparison telemetry"))
      const pending = new Set<Promise<void>>()
      const controllers = new Set<AbortController>()
          let inputStarted = performance.now()
      let eligibleInput = true
      let skillPaths = new Map<string, string>()
      let skillFiles = new Map<string, string>()
      let turn: { id: string; sessionId: string; started: number; firstTextMs: number | null } | undefined

      pi.on("input", (event) => {
        const input = inputSchema.safeParse(event)
        eligibleInput = input.success && input.data.source !== "extension"
        inputStarted = performance.now()
      })
      pi.on("before_agent_start", async (event, eventCtx) => {
        const parsed = startSchema.safeParse(event)
        if (!parsed.success || !parsed.data.prompt.trim() || !eligibleInput) return
        if (!record(eventCtx) || !record(eventCtx.sessionManager)) return
        const manager = eventCtx.sessionManager
        if (typeof manager.getSessionId !== "function") return
        const sessionId: unknown = manager.getSessionId.call(manager)
        if (typeof sessionId !== "string") return
        const commands = pi.getCommands?.() ?? []
        const candidates: SkillCandidate[] = commands
          .filter((command) => command.source === "skill")
          .map((command) => ({ name: command.name.replace(/^skill:/, ""), description: command.description ?? "" }))
          .sort((left, right) => left.name.localeCompare(right.name))
        skillPaths = new Map(
          commands.flatMap((command) =>
            command.source === "skill" && command.sourceInfo?.path
              ? [[resolve(command.sourceInfo.path), command.name.replace(/^skill:/, "")]]
              : [],
          ),
        )
        skillFiles = new Map(
          commands.flatMap((command) =>
            command.source === "skill" && command.sourceInfo?.path
              ? [[command.name.replace(/^skill:/, ""), resolve(command.sourceInfo.path)]]
              : [],
          ),
        )
        const current: { id: string; sessionId: string; started: number; firstTextMs: number | null } = { id: randomUUID(), sessionId, started: inputStarted, firstTextMs: null }
        turn = current
        const base = {
          schemaVersion: 1 as const,
          mode,
          sessionId: current.sessionId,
          turnId: current.id,
        }
        await telemetry.write({
          ...base,
          at: new Date().toISOString(),
          event: "turn_start",
          promptHash: digest(parsed.data.prompt),
          catalogHash: digest(JSON.stringify(candidates)),
          candidateCount: candidates.length,
          threshold,
          timeoutMs,
          descriptionCap,
          baselineRevision: process.env.OMO_JEV_PILOT_BASELINE_REVISION,
        })
        if (mode === "off") return
        const controller = new AbortController()
        controllers.add(controller)
        const request = requestAdvice({
          mode,
          prompt: parsed.data.prompt,
          candidates,
          key: process.env.TYPESAFE_API_KEY,
          signal: controller.signal,
          timeoutMs,
          threshold,
          descriptionCap,
          url: endpoint,
        })
        if (mode === "shadow") {
          const observation = request.then(async (advice) => {
            await telemetry.write({ ...base, at: new Date().toISOString(), event: "advice", ...advice })
            controllers.delete(controller)
          })
          pending.add(observation)
          void observation.finally(() => pending.delete(observation))
          return
        }
        const advice = await request
        controllers.delete(controller)
        await telemetry.write({ ...base, at: new Date().toISOString(), event: "advice", ...advice })
        if (advice.status !== "ok" || turn !== current) return
        if (advice.suggestions.length === 0) {
          // "No skill applies" is still a decision: the compact catalog keeps every skill reachable and the same cached prefix.
          if (mode !== "auto" || parsed.data.systemPrompt === undefined) return
          const compacted = pruneSkillCatalog(parsed.data.systemPrompt, [], 0)
          await telemetry.write({
            ...base, at: new Date().toISOString(), event: "catalog",
            beforeChars: compacted?.beforeChars ?? 0, afterChars: compacted?.afterChars ?? 0,
            keptFull: [], compacted: compacted?.compacted ?? 0, digestChars: 0,
          })
          return compacted === undefined ? undefined : { systemPrompt: compacted.prompt }
        }
        const scoreOf = new Map(advice.scores.map((entry) => [entry.skill, entry.score]))
        const ranked = [...advice.suggestions].sort((left, right) => (scoreOf.get(right) ?? 0) - (scoreOf.get(left) ?? 0))
        const adviceList = ranked.map((name) => {
          const score = scoreOf.get(name)
          return score === undefined ? name : `${name} (${score.toFixed(2)})`
        })
        if (mode === "advisory") {
          return {
            message: {
              customType: "jev-skill-advice",
              content:
                `[jev-skill-advice] Optional skill advice for this task: ${adviceList.join(", ")}. ` +
                "These are suggestions, not instructions. Select every skill actually needed, including other skills or none. " +
                "Keep your normal planning, category and model choices.",
              display: false,
            },
          }
        }
        // The catalog compacts identically for every task, so the system prompt stays one cacheable prefix across
        // sessions; everything task-specific travels in the hidden message after that prefix.
        const pruned = parsed.data.systemPrompt === undefined
          ? undefined
          : pruneSkillCatalog(parsed.data.systemPrompt, [], 0)
        const descriptionOf = new Map(candidates.map((candidate) => [candidate.name, candidate.description]))
        const picks = ranked.slice(0, KEEP_FULL_SHORTLIST).map((name, index) => `- ${adviceList[index]}: ${descriptionOf.get(name) ?? ""}`)
        const top = ranked[0]
        const digestText = top === undefined ? undefined : await readSkillDigest(top, parsed.data.systemPrompt)
        await telemetry.write({
          ...base,
          at: new Date().toISOString(),
          event: "catalog",
          beforeChars: pruned?.beforeChars ?? 0,
          afterChars: pruned?.afterChars ?? 0,
          keptFull: pruned?.keptFull ?? [],
          compacted: pruned?.compacted ?? 0,
          digestChars: digestText === undefined ? 0 : digestText.length,
        })
        const guidance = digestText === undefined || top === undefined
          ? ""
          : ` Guidance from \"${top}\":\n${digestText}`
        return {
          ...(pruned === undefined ? {} : { systemPrompt: pruned.prompt }),
          message: {
            customType: "jev-skill-advice",
            content:
              `[jev-skill-advice] Jev selected for this task:\n${picks.join("\n")}\n` +
              "The system catalog lists every skill by name and location only; read any of them when the task calls for it. " +
              "Select every skill actually needed, including others or none." +
              guidance,
            display: false,
          },
        }
      })

      async function readSkillDigest(name: string, systemPrompt: string | undefined): Promise<string | undefined> {
        const location = systemPrompt === undefined ? undefined : findSkillLocation(systemPrompt, name)
        const file = (location === undefined ? undefined : resolveSkillFile(location, extractSkillRoots(systemPrompt ?? ""))) ?? skillFiles.get(name)
        if (file === undefined) return undefined
        try {
          return buildSkillDigest(await readFile(file, "utf8"), DIGEST_MAX_CHARS)
        } catch (error) {
          ctx.logger.debug?.("[Jev pilot] Could not read the selected skill", { skill: name, error: String(error) })
          return undefined
        }
      }
      pi.on("message_update", (event) => {
        const update = updateSchema.safeParse(event)
        if (turn && turn.firstTextMs === null && update.success && update.data.assistantMessageEvent.delta) {
          turn.firstTextMs = performance.now() - turn.started
        }
      })
      pi.on("message_end", async (event) => {
        const message = messageSchema.safeParse(event)
        if (!turn || !message.success) return
        await telemetry.write({
          schemaVersion: 1, mode, at: new Date().toISOString(), sessionId: turn.sessionId, turnId: turn.id,
          event: "assistant", ...message.data.message, firstTextMs: turn.firstTextMs,
        })
      })
      pi.on("tool_call", async (event) => {
        const task = taskSchema.safeParse(event)
        const read = readSchema.safeParse(event)
        if (!turn) return
        const parentSkill = read.success ? skillPaths.get(resolve(pi.cwd ?? process.cwd(), read.data.input.path)) : undefined
        if (!task.success && !parentSkill) return
        await telemetry.write({
          schemaVersion: 1, mode, at: new Date().toISOString(), sessionId: turn.sessionId, turnId: turn.id,
          event: "skill_choice",
          loadSkills: task.success ? task.data.input.load_skills ?? [] : parentSkill ? [parentSkill] : [],
          selectionTarget: task.success ? "task" : "parent_read",
          category: task.success ? task.data.input.category : undefined,
          subagentType: task.success ? task.data.input.subagent_type : undefined,
        })
      })
      pi.on("agent_end", async () => {
        if (!turn) return
        await telemetry.write({
          schemaVersion: 1, mode, at: new Date().toISOString(), sessionId: turn.sessionId, turnId: turn.id,
          event: "turn_end", durationMs: performance.now() - turn.started, firstTextMs: turn.firstTextMs,
        })
        turn = undefined
      })
      pi.on("session_shutdown", async () => {
        for (const controller of controllers) controller.abort()
        await Promise.all(pending)
        await telemetry.flush()
      })
    },
  }
}
