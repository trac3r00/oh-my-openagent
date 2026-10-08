import { afterEach, describe, expect, test } from "bun:test"
import { watch } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SenpiExtensionAPI } from "../../extension/types"
import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { createJevSkillAdvisorComponent } from "./component"
import { pruneSkillCatalog } from "./catalog"
import { DECISION_MODEL } from "./decision"

const environment = { ...process.env }
const directories: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(async () => {
  for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name]
  Object.assign(process.env, environment)
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function setup(mode: "off" | "shadow" | "advisory" | "auto", fetch?: (request: Request) => Response | Promise<Response>) {
  const directory = await mkdtemp(join(tmpdir(), "jev-component-test-"))
  directories.push(directory)
  process.env.OMO_JEV_PILOT_MODE = mode
  process.env.OMO_JEV_PILOT_LOG_DIR = directory
  process.env.TYPESAFE_API_KEY = "fixture"
  if (fetch) {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })
    servers.push(server)
    process.env.OMO_JEV_PILOT_URL = server.url.toString()
  } else delete process.env.OMO_JEV_PILOT_URL
  const pi = new FakeExtensionAPI()
  const api = Object.assign(pi, {
    getCommands: () => [
      { name: "skill:programming", description: "Typed language work", source: "skill", sourceInfo: { path: "/skills/programming/SKILL.md" } },
      { name: "skill:debugging", description: "Diagnose faults", source: "skill", sourceInfo: { path: "/skills/debugging/SKILL.md" } },
      { name: "help", description: "Not a skill", source: "extension" },
    ],
  })
  const context = { sessionManager: { getSessionId: () => "test-session" } }
  createJevSkillAdvisorComponent().register(api as unknown as SenpiExtensionAPI, { logger: console, config: { getFlag: () => undefined } })
  const records = async () => (await readFile(join(directory, "test-session.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  return { pi, context, directory, records }
}

function response(scores = [0.95, 0.9]) {
  // The actual catalog is sorted: debugging before programming.
  return Response.json({
    model: DECISION_MODEL,
    answers: Object.fromEntries(scores.map((noul, index) => [`s${index}`, { type: "noul", noul }])),
    usage: { input_tokens: 50, output_tokens: 0 },
  })
}

function adviceWritten(directory: string) {
  return new Promise<void>((resolve, reject) => {
    const signal = AbortSignal.timeout(3000)
    const watcher = watch(directory, async (_, filename) => {
      if (filename !== "test-session.jsonl") return
      try {
        const lines = (await readFile(join(directory, filename), "utf8")).trim().split("\n")
        if (!lines.some((line) => { try { return JSON.parse(line).event === "advice" } catch { return false } })) return
        watcher.close()
        resolve()
      } catch (error) { watcher.close(); reject(error) }
    })
    signal.addEventListener("abort", () => { watcher.close(); reject(new Error("No advice record event")) }, { once: true })
  })
}

// Six entries keep the shortlist smaller than the catalog, which is what makes the prune observable.
const CATALOG_SKILLS = ["debugging", "programming", "frontend", "spotify", "herdr", "browser", "notion"]
function promptWithCatalog(root: string, entries = CATALOG_SKILLS): string {
  return [
    "## Identity",
    "",
    "<skill_roots>",
    `  <r0>${root}</r0>`,
    "</skill_roots>",
    "A location's `rN/` prefix expands to the matching root above.",
    "",
    "<available_skills>",
    ...entries.map((name) => [
      "  <skill>",
      `    <name>${name}</name>`,
      `    <description>Reference text for ${name}</description>`,
      `    <location>r0/${name}/SKILL.md</location>`,
      "  </skill>",
    ].join("\n")),
    "</available_skills>",
    "",
    "## Workstation",
    "",
  ].join("\n")
}

describe("pilot hooks preserve caller decisions", () => {
  test("off records observed task choices and usage without a request or message", async () => {
    let calls = 0
    const { pi, context, records } = await setup("off", () => { calls++; return response() })
    const before = await pi.dispatch("before_agent_start", { prompt: "secret task text", systemPrompt: "existing catalog" }, context)
    await pi.dispatch("message_update", { assistantMessageEvent: { type: "text_delta", delta: "Working" } }, context)
    await pi.dispatch("tool_call", { toolName: "task", input: { load_skills: ["programming"], category: "quick", prompt: "secret child text" } }, context)
    await pi.dispatch("message_end", { message: { role: "assistant", provider: "fixture", model: "test", usage: { input: 3, output: 2, cacheRead: 0 } } }, context)
    await pi.dispatch("agent_end", {}, context)
    await pi.dispatch("session_shutdown", {}, context)
    expect(before).toEqual([undefined])
    expect(calls).toBe(0)
    const data = await records()
    expect(data.map((record) => record.event)).toEqual(["turn_start", "skill_choice", "assistant", "turn_end"])
    expect(data[1].loadSkills).toEqual(["programming"])
    expect(data[2].usage).toEqual({ input: 3, output: 2, cacheRead: 0 })
    expect(data[3].firstTextMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(data)).not.toContain("secret")
    expect(JSON.stringify(data)).not.toContain("Bearer")
  })

  test("shadow starts inference but does not wait for or inject its result", async () => {
    const received = Promise.withResolvers<void>()
    const reply = Promise.withResolvers<Response>()
    const { pi, context, directory, records } = await setup("shadow", () => { received.resolve(); return reply.promise })
    const written = adviceWritten(directory)
    const before = await pi.dispatch("before_agent_start", { prompt: "Fix a crash", systemPrompt: "unchanged" }, context)
    expect(before).toEqual([undefined])
    await received.promise
    reply.resolve(response())
    await written
    await pi.dispatch("session_shutdown", {}, context)
    const advice = (await records()).find((record) => record.event === "advice")
    expect(advice).toMatchObject({ status: "ok", suggestions: ["debugging", "programming"] })
    expect(pi.messages).toEqual([])
  })

  test("advisory returns only an ignorable message, never a system prompt or task call", async () => {
    const { pi, context, records } = await setup("advisory", () => response())
    const results = await pi.dispatch("before_agent_start", { prompt: "Fix a crash", systemPrompt: "unchanged" }, context)
    expect(results[0]).toMatchObject({ message: { customType: "jev-skill-advice", display: false } })
    expect(results[0]).not.toHaveProperty("systemPrompt")
    expect(results[0]).not.toHaveProperty("toolCalls")
    const content = (results[0] as { message: { content: string } }).message.content
    expect(content).toContain("(0.95)")
    expect(content.indexOf("debugging")).toBeLessThan(content.indexOf("programming"))
    await pi.dispatch("session_shutdown", {}, context)
    const advice = (await records()).find((record) => record.event === "advice")
    expect(advice.suggestions).toEqual(["debugging", "programming"])
    expect(advice.primary).toBe("debugging")
  })

  test("#given a description cap in the environment #when advice is requested #then the request carries capped descriptions and telemetry records the cap", async () => {
    // given
    process.env.OMO_JEV_PILOT_DESCRIPTION_CAP = "12"
    const received = Promise.withResolvers<{ state: string }>()
    const { pi, context, records } = await setup("advisory", async (request) => {
      received.resolve(await request.json() as { state: string })
      return response()
    })
    // when
    await pi.dispatch("before_agent_start", { prompt: "Fix a crash" }, context)
    // then
    const lines = ((await received.promise).state as string).split("\n")
    const programming = lines.find((line) => line.startsWith("s1 | programming | "))
    expect(programming).toBeDefined()
    expect(programming!.endsWith("…")).toBe(true)
    expect(programming!.length - "s1 | programming | ".length).toBeLessThanOrEqual(13)
    await pi.dispatch("session_shutdown", {}, context)
    expect((await records()).find((record) => record.event === "turn_start")).toMatchObject({ descriptionCap: 12 })
  })

  test("auto mode compacts every catalog entry and moves the picks and guidance into the message", async () => {
    const skills = await mkdtemp(join(tmpdir(), "jev-skill-fixture-"))
    directories.push(skills)
    await Bun.write(join(skills, "debugging", "SKILL.md"), "---\nname: debugging\n---\n\nDIGEST-MARKER: reproduce first.\n")
    const { pi, context, records } = await setup("auto", () => response())
    const basePrompt = promptWithCatalog(skills)
    const results = await pi.dispatch("before_agent_start", { prompt: "Fix a crash", systemPrompt: basePrompt }, context)
    const result = results[0] as { systemPrompt?: string; message?: { content: string } }
    expect(result.message?.content).toContain("DIGEST-MARKER")
    expect(result.message?.content).toContain("Diagnose faults")
    const pruned = result.systemPrompt ?? ""
    expect(pruned).not.toContain("Reference text for")
    expect(pruned).toContain("<name>spotify</name>")
    expect(pruned).toContain("<location>r0/spotify/SKILL.md</location>")
    expect(pruned.startsWith("## Identity")).toBe(true)
    expect(pruned.endsWith("## Workstation\n")).toBe(true)
    await pi.dispatch("session_shutdown", {}, context)
    const catalog = (await records()).find((record) => record.event === "catalog")
    expect(catalog).toMatchObject({ keptFull: [], compacted: CATALOG_SKILLS.length })
    expect(catalog.beforeChars).toBeGreaterThan(catalog.afterChars)
    expect(catalog.digestChars).toBeGreaterThan(0)
  })

  test("auto mode keeps identical system prompt bytes when the picks change between turns", async () => {
    let calls = 0
    const { pi, context } = await setup("auto", () => { calls++; return calls === 1 ? response([0.2, 0.95]) : response([0.95, 0.2]) })
    const basePrompt = promptWithCatalog(await mkdtemp(join(tmpdir(), "jev-skill-fixture-")))
    const first = await pi.dispatch("before_agent_start", { prompt: "Write TypeScript", systemPrompt: basePrompt }, context)
    const second = await pi.dispatch("before_agent_start", { prompt: "Now debug a crash", systemPrompt: basePrompt }, context)
    const firstPrompt = (first[0] as { systemPrompt?: string }).systemPrompt
    const secondPrompt = (second[0] as { systemPrompt?: string }).systemPrompt
    expect(firstPrompt).toBeDefined()
    expect(secondPrompt).toBe(firstPrompt)
    expect((first[0] as { message: { content: string } }).message.content).toContain("- programming (0.95): Typed language work")
    expect((second[0] as { message: { content: string } }).message.content).toContain("- debugging (0.95): Diagnose faults")
    await pi.dispatch("session_shutdown", {}, context)
  })

  test("auto mode compacts the catalog without a message when Jev picks no skill", async () => {
    const { pi, context } = await setup("auto", () => response([0.1, 0.2]))
    const basePrompt = promptWithCatalog("/skills")
    const results = await pi.dispatch("before_agent_start", { prompt: "Sum a CSV", systemPrompt: basePrompt }, context)
    const result = results[0] as { systemPrompt?: string; message?: unknown }
    expect(result.message).toBeUndefined()
    expect(result.systemPrompt).toBe(pruneSkillCatalog(basePrompt, [], 0)?.prompt)
    await pi.dispatch("session_shutdown", {}, context)
  })

  test("auto mode leaves both the prompt and the message untouched when advice fails", async () => {
    const { pi, context } = await setup("auto", () => new Response("nope", { status: 500 }))
    const before = await pi.dispatch("before_agent_start", { prompt: "Fix a crash", systemPrompt: promptWithCatalog("/skills") }, context)
    expect(before).toEqual([undefined])
    await pi.dispatch("session_shutdown", {}, context)
  })

  test("a parent skill read is recorded separately from child task selection", async () => {
    const { pi, context, records } = await setup("off")
    await pi.dispatch("before_agent_start", { prompt: "Write TypeScript" }, context)
    await pi.dispatch("tool_call", { toolName: "read", input: { path: "/skills/programming/SKILL.md" } }, context)
    await pi.dispatch("tool_call", { toolName: "read", input: { path: "/unrelated/notes.md" } }, context)
    await pi.dispatch("session_shutdown", {}, context)
    expect((await records()).filter((record) => record.event === "skill_choice")).toEqual([
      expect.objectContaining({ selectionTarget: "parent_read", loadSkills: ["programming"] }),
    ])
  })

  test("none and unavailable credentials preserve the original prompt", async () => {
    const { pi, context, records } = await setup("advisory", () => response([0.1, 0.2]))
    expect(await pi.dispatch("before_agent_start", { prompt: "No skills needed" }, context)).toEqual([undefined])
    delete process.env.TYPESAFE_API_KEY
    expect(await pi.dispatch("before_agent_start", { prompt: "Another task" }, context)).toEqual([undefined])
    await pi.dispatch("session_shutdown", {}, context)
    expect((await records()).filter((record) => record.event === "advice").map((record) => record.reason ?? record.status)).toEqual(["ok", "missing_key"])
  })

  test("an extension-origin input is not another user-prompt evaluation", async () => {
    let calls = 0
    const { pi, context } = await setup("advisory", () => { calls++; return response() })
    await pi.dispatch("input", { source: "extension" }, context)
    expect(await pi.dispatch("before_agent_start", { prompt: "Background job" }, context)).toEqual([undefined])
    expect(calls).toBe(0)
  })
})
