import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultEnvFile, defaultLogDir, launchSpec, loadEnvFile, parseEnvFile, parsePilotArgs, readPilotLogs, runLaunch, summarize, type PilotEvent } from "./jev-pilot"

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "jev-pilot-test-"))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const at = "2026-10-01T12:00:00.000Z"
const base = { schemaVersion: 1, at, sessionId: "session-a", turnId: "turn-a" } as const

describe("pilot launch", () => {
  test("#given a default launch #when parsed #then shadow passes normal arguments unchanged", () => {
    // given
    const args = ["launch", "--", "-p", "hello world", "--model", "provider/model"]
    // when
    const parsed = parsePilotArgs(args)
    // then
    expect(parsed).toEqual({ command: "launch", mode: "shadow", passthrough: ["-p", "hello world", "--model", "provider/model"] })
  })

  test("#given explicit modes and a log directory #when parsed #then only pilot flags are consumed", () => {
    // given
    const args = ["launch", "--mode", "off", "--log-dir", "/tmp/pilot logs", "--", "say", "hi"]
    // when
    const parsed = parsePilotArgs(args)
    // then
    expect(parsed).toEqual({ command: "launch", mode: "off", logDir: "/tmp/pilot logs", passthrough: ["say", "hi"] })
    expect(parsePilotArgs(["launch", "--mode", "advisory", "--"])).toMatchObject({ mode: "advisory" })
    expect(parsePilotArgs(["launch", "--mode", "auto", "--"])).toMatchObject({ mode: "auto" })
    expect(() => parsePilotArgs(["launch", "--mode", "unknown"])).toThrow("--mode")
    expect(() => parsePilotArgs(["launch", "--", "-e", "other.js"])).toThrow("extension")
  })

  test("#given built fork paths #when launch spec is created #then argv and env isolate the pilot", () => {
    // given
    const root = fixture()
    const launcher = join(root, "packages", "omo-native", "bin", "omo.js")
    const extension = join(root, "packages", "omo-native", "plugin", "extensions", "omo.js")
    mkdirSync(join(root, "packages", "omo-native", "bin"), { recursive: true })
    mkdirSync(join(root, "packages", "omo-native", "plugin", "extensions"), { recursive: true })
    writeFileSync(launcher, "")
    writeFileSync(extension, "")
    const env = { HOME: root, AUTH_MARKER: "preserved", OMO_JEV_PILOT_LOG_DIR: join(root, "prior") }
    // when
    const spec = launchSpec({ mode: "advisory", passthrough: ["--print", "hello world"], logDir: join(root, "chosen") }, env, root)
    // then
    expect(spec.argv).toEqual([process.execPath, launcher, "--no-extensions", "--print", "hello world"])
    expect(spec.env).toMatchObject({
      AUTH_MARKER: "preserved", OMO_DEV: "1", OMO_JEV_PILOT_MODE: "advisory",
      OMO_JEV_PILOT_BASELINE_REVISION: "2afeed86cfbcc0de250321955589e905bcdc0acc",
      OMO_JEV_PILOT_LOG_DIR: join(root, "chosen"),
    })
    expect(defaultLogDir(root)).toBe(join(root, ".omo", "jev-pilot", "logs"))
  })

  test("#given an unbuilt fork #when launch is prepared #then the missing artifact has a build hint", () => {
    // given
    const root = fixture()
    mkdirSync(join(root, "packages", "omo-native", "bin"), { recursive: true })
    writeFileSync(join(root, "packages", "omo-native", "bin", "omo.js"), "")
    // when / then
    expect(() => launchSpec({ mode: "shadow", passthrough: [] }, {}, root)).toThrow("build the fork plugin")
  })

  test("#given a child with nonzero status #when run #then its exit status propagates", async () => {
    // given
    const spec = { argv: [process.execPath, "-e", "process.exit(37)"], env: { ...process.env } }
    // when
    const status = await runLaunch(spec)
    // then
    expect(status).toBe(37)
  })

  test.skipIf(process.platform === "win32")("#given a child killed by SIGTERM #when run #then the launch process ends with SIGTERM", async () => {
    // given: an outer child isolates the test runner from the intentional signal.
    const modulePath = join(import.meta.dir, "jev-pilot.ts")
    const code = `import { runLaunch } from ${JSON.stringify(modulePath)};
await runLaunch({ argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"], env: { ...process.env } })`
    // when
    const parent = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" })
    await parent.exited
    // then
    expect(parent.signalCode).toBe("SIGTERM")
  })
})

describe("pilot report", () => {
  test("#given auto catalog records #when summarized #then saved characters and compaction are reported per mode", () => {
    const events = [
      { ...base, event: "catalog", mode: "auto", beforeChars: 22000, afterChars: 7000, keptFull: ["git-master"], compacted: 55, digestChars: 1200 },
      { ...base, event: "catalog", mode: "auto", beforeChars: 22000, afterChars: 7000, keptFull: ["git-master"], compacted: 55, digestChars: 900 },
    ]
    const summary = summarize(events as never)
    expect(summary.auto).toMatchObject({
      catalog: { events: 2, beforeChars: 44000, afterChars: 14000, savedChars: 30000, compacted: 110, digestChars: 2100 },
    })
    expect(summary.shadow).toMatchObject({ catalog: { events: 0, savedChars: 0 } })
  })

  test("#given mixed modes and missing usage #when summarized #then zero is reported only when observed", () => {
    // given
    const events: PilotEvent[] = [
      { ...base, event: "turn_start", mode: "shadow", promptHash: "hash", catalogHash: "catalog", candidateCount: 2, threshold: 0.8, timeoutMs: 1500, baselineRevision: "2afeed86cfbcc0de250321955589e905bcdc0acc" },
      { ...base, event: "advice", mode: "shadow", status: "ok", durationMs: 12, suggestions: ["alpha", "beta"], scores: [{ skill: "alpha", score: 0.8 }], decisionModel: "jev-1.13.0", usage: { input_tokens: 0, output_tokens: 4 } },
      { ...base, event: "skill_choice", mode: "shadow", selectionTarget: "task", loadSkills: ["beta", "other"] },
      { ...base, event: "assistant", mode: "shadow", provider: "local", model: "main", firstTextMs: null, usage: { input: 0, output: 8 } },
      { ...base, event: "turn_end", mode: "shadow", durationMs: 40, firstTextMs: null },
      { ...base, event: "advice", mode: "off", status: "skipped", durationMs: 0, suggestions: [], scores: [], decisionModel: "jev-1.13.0" },
      { ...base, event: "assistant", mode: "off", firstTextMs: 0 },
      { ...base, event: "turn_end", mode: "off", durationMs: 22, firstTextMs: 0 },
      { ...base, sessionId: "session-b", turnId: "turn-b", event: "advice", mode: "shadow", status: "failed", durationMs: 5, suggestions: [], scores: [], decisionModel: "jev-1.13.0" },
    ]
    // when
    const summary = summarize(events)
    // then
    expect(summary.shadow).toMatchObject({
      sessions: 2, turns: 2, requests: { ok: 1, skipped: 0, failed: 1 },
      suggestionChoiceOverlap: { byTarget: { task: { comparableTurns: 1, overlapTurns: 1, suggestedNames: 2, overlappingNames: 1 }, parent_read: { comparableTurns: 0 } } },
      reported: { assistantTokens: { input: { samples: 1, sum: 0 }, output: { samples: 1, sum: 8 }, cacheRead: { samples: 0, sum: null } }, adviceTokens: { input_tokens: { samples: 1, sum: 0 } } },
      firstTextMs: { samples: 0, total: 1, medianMs: null },
    })
    expect(summary.off).toMatchObject({ sessions: 1, turns: 1, requests: { skipped: 1 }, firstTextMs: { samples: 1, total: 1, medianMs: 0 }, reported: { assistantTokens: { input: { samples: 0 } } } })
    expect(summary.advisory).toMatchObject({ sessions: 0, turns: 0 })
  })

  test("#given assistant usage across sessions #when summarized #then cache-hit last and session percentages are reported", () => {
    // given: two sessions carry input/cacheRead usage and one session has no usage at all
    const events: PilotEvent[] = [
      { ...base, sessionId: "session-a", turnId: "turn-1", event: "assistant", mode: "auto", firstTextMs: 0, usage: { input: 1000, cacheRead: 9000, cacheWrite: 500 } },
      { ...base, sessionId: "session-a", turnId: "turn-2", event: "assistant", mode: "auto", firstTextMs: 0, usage: { input: 100, cacheRead: 9900, cacheWrite: 0 } },
      { ...base, sessionId: "session-b", turnId: "turn-3", event: "assistant", mode: "auto", firstTextMs: 0, usage: { input: 0, cacheRead: 5000, cacheWrite: 0 } },
      { ...base, sessionId: "session-c", turnId: "turn-4", event: "assistant", mode: "auto", firstTextMs: 0 },
    ]
    // when
    const summary = summarize(events)
    // then: the final observed request per session scores 99.0 and 100.0; the session window is 23900 / 25000
    expect(summary.auto).toMatchObject({
      cacheHit: {
        lastRequests: { samples: 2, median: 99, p95: 100 },
        sessionPercent: 95.6,
        sums: { input: 1100, cacheRead: 23900, cacheWrite: 500 },
      },
    })
    expect(summary.off).toMatchObject({ cacheHit: { lastRequests: { samples: 0, median: null }, sessionPercent: null, sums: { input: null, cacheRead: null } } })
  })

  test("#given advice with a primary and usage #when summarized #then the ranked pick and published-rate cost appear", () => {
    // given
    const events: PilotEvent[] = [
      { ...base, event: "advice", mode: "shadow", status: "ok", durationMs: 10, suggestions: ["alpha", "beta"], primary: "alpha", scores: [{ skill: "alpha", score: 0.95 }], decisionModel: "jev-1.13.0", usage: { input_tokens: 1000, output_tokens: 5 } },
    ]
    // when
    const summary = summarize(events)
    // then
    expect(summary.shadow).toMatchObject({ primarySkills: { alpha: 1 }, estimatedAdviceCostUsd: 0.000042 })
  })

  test("#given an empty suggestion and a separate skill choice #when summarized #then overlap is not invented", () => {
    // given
    const events: PilotEvent[] = [
      { ...base, event: "advice", mode: "advisory", status: "ok", durationMs: 3, suggestions: [], scores: [], decisionModel: "jev-1.13.0" },
      { ...base, event: "skill_choice", mode: "advisory", selectionTarget: "parent_read", loadSkills: ["unrelated"] },
      { ...base, event: "turn_end", mode: "advisory", durationMs: 10, firstTextMs: 4 },
    ]
    // when
    const summary = summarize(events)
    // then
    expect(summary.advisory).toMatchObject({
      requests: { noSuggestions: 1 }, suggestionChoiceOverlap: { byTarget: { parent_read: { comparableTurns: 1, overlapTurns: 0, suggestedNames: 0, overlappingNames: 0 }, task: { comparableTurns: 0 } } },
      chosenSkills: { task: {}, parent_read: { unrelated: 1 } }, durationMs: { turn: { medianMs: 10, p95Ms: 10 } },
    })
  })

  test("#given a task choice and a parent read #when summarized #then overlap stays separated by target", () => {
    // given
    const events: PilotEvent[] = [
      { ...base, event: "advice", mode: "shadow", status: "ok", durationMs: 1, suggestions: ["alpha"], scores: [], decisionModel: "jev-1.13.0" },
      { ...base, event: "skill_choice", mode: "shadow", selectionTarget: "task", loadSkills: ["beta"] },
      { ...base, event: "skill_choice", mode: "shadow", selectionTarget: "parent_read", loadSkills: ["alpha"] },
    ]
    // when
    const summary = summarize(events)
    // then
    expect(summary.shadow).toMatchObject({
      suggestionChoiceOverlap: { byTarget: { task: { overlapTurns: 0, overlappingNames: 0 }, parent_read: { overlapTurns: 1, overlappingNames: 1 } } },
      chosenSkills: { task: { beta: 1 }, parent_read: { alpha: 1 } },
    })
  })

  test("#given JSONL plus unrelated files #when read #then only validated JSONL records appear", async () => {
    // given
    const root = fixture()
    const event = { ...base, event: "turn_end", mode: "off", durationMs: 0, firstTextMs: null, futureField: "allowed" }
    writeFileSync(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`)
    writeFileSync(join(root, "ignore.txt"), "not JSON")
    // when
    const records = await readPilotLogs(root)
    // then
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject(event)
  })

  test("#given local JSONL #when report CLI runs #then it prints grouped aggregates", async () => {
    // given
    const root = fixture()
    writeFileSync(join(root, "sample.jsonl"), `${JSON.stringify({ ...base, event: "turn_end", mode: "off", durationMs: 7, firstTextMs: 0 })}\n`)
    // when
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "jev-pilot.ts"), "report", "--log-dir", root], { stdout: "pipe", stderr: "pipe" })
    const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
    // then
    expect(exit).toBe(0)
    expect(JSON.parse(output).off).toMatchObject({ sessions: 1, turns: 1, firstTextMs: { samples: 1, medianMs: 0 } })
  })

  test("#given malformed JSONL #when read #then filename and line surface without its contents", async () => {
    // given
    const root = fixture()
    writeFileSync(join(root, "broken.jsonl"), `${JSON.stringify({ ...base, event: "turn_end", mode: "off", durationMs: 1, firstTextMs: null })}\nSECRET_CONTENT`)
    // when / then
    const error = await readPilotLogs(root).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("broken.jsonl:2")
    expect(String(error)).not.toContain("SECRET_CONTENT")
  })
})

describe("pilot environment file", () => {
  test("#given env text #when parsed #then only pilot names apply and quoting is stripped", () => {
    // given
    const text = [
      "# comment",
      "",
      "export TYPESAFE_API_KEY='first'",
      'OMO_JEV_PILOT_LOG_DIR="/tmp/pilot logs"',
      "OMO_JEV_PILOT_TIMEOUT_MS=2500   ",
      "OMO_JEV_PILOT_DESCRIPTION_CAP=240",
      "NOT_A_PILOT_ENTRY=ignored",
      "PATH=/tmp/evil",
      "TYPESAFE_API_KEY=last-wins",
      "not a pair",
    ].join("\n")
    // when
    const parsed = parseEnvFile(text)
    // then
    expect(parsed.values).toEqual({ TYPESAFE_API_KEY: "last-wins", OMO_JEV_PILOT_LOG_DIR: "/tmp/pilot logs", OMO_JEV_PILOT_TIMEOUT_MS: "2500", OMO_JEV_PILOT_DESCRIPTION_CAP: "240" })
    expect(parsed.ignoredNames).toEqual(["NOT_A_PILOT_ENTRY", "PATH"])
    expect(defaultEnvFile("/home/example")).toBe("/home/example/.omo/jev-pilot/.env")
  })

  test("#given a missing or permissive file #when loaded #then absence is empty and loose mode follows the platform", () => {
    // given
    const root = fixture()
    const file = join(root, "pilot.env")
    // when / then
    expect(loadEnvFile(join(root, "absent.env"))).toEqual({ values: {}, ignoredNames: [], permissive: false })
    writeFileSync(file, "TYPESAFE_API_KEY=placeholder\n")
    chmodSync(file, 0o644)
    expect(loadEnvFile(file)).toMatchObject({ values: { TYPESAFE_API_KEY: "placeholder" } })
    expect(loadEnvFile(file).permissive).toBe(process.platform !== "win32")
    chmodSync(file, 0o600)
    expect(loadEnvFile(file).permissive).toBe(false)
  })

  test("#given env mode #when parsed #then the flag wins and only launch validates the environment", () => {
    // given / when / then
    expect(parsePilotArgs(["launch", "--"], "advisory")).toMatchObject({ mode: "advisory" })
    expect(parsePilotArgs(["launch", "--mode", "off", "--"], "advisory")).toMatchObject({ mode: "off" })
    expect(parsePilotArgs(["launch", "--"])).toMatchObject({ mode: "shadow" })
    expect(() => parsePilotArgs(["launch", "--"], "invalid")).toThrow("OMO_JEV_PILOT_MODE")
    expect(parsePilotArgs(["report"], "invalid")).toMatchObject({ mode: "shadow" })
  })

  test("#given an env file #when report runs #then the file supplies the log directory but the real environment wins", async () => {
    // given
    const root = fixture()
    const fileLogs = join(root, "file logs")
    const realLogs = join(root, "real logs")
    mkdirSync(fileLogs)
    mkdirSync(realLogs)
    const event = (durationMs: number) => `${JSON.stringify({ ...base, event: "turn_end", mode: "off", durationMs, firstTextMs: null })}\n`
    writeFileSync(join(fileLogs, "events.jsonl"), event(70))
    writeFileSync(join(realLogs, "events.jsonl"), event(7))
    const envFile = join(root, "pilot.env")
    writeFileSync(envFile, `OMO_JEV_PILOT_LOG_DIR=${fileLogs}\nNOT_A_PILOT_ENTRY=super-secret-value\n`)
    chmodSync(envFile, 0o600)
    const run = async (env: NodeJS.ProcessEnv) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "jev-pilot.ts"), "report"], { env, stdout: "pipe", stderr: "pipe" })
      const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { exit, output, errors }
    }
    const baseEnv: NodeJS.ProcessEnv = { ...process.env, OMO_JEV_PILOT_ENV_FILE: envFile }
    delete baseEnv.OMO_JEV_PILOT_MODE
    delete baseEnv.OMO_JEV_PILOT_LOG_DIR
    // when
    const fromFile = await run(baseEnv)
    const fromEnvironment = await run({ ...baseEnv, OMO_JEV_PILOT_LOG_DIR: realLogs })
    const fromEmptyEnvironment = await run({ ...baseEnv, OMO_JEV_PILOT_LOG_DIR: "", TYPESAFE_API_KEY: "" })
    // then
    expect(fromFile.exit).toBe(0)
    expect(JSON.parse(fromFile.output).off).toMatchObject({ turns: 1, durationMs: { turn: { medianMs: 70 } } })
    expect(fromFile.errors).toContain("NOT_A_PILOT_ENTRY")
    expect(fromFile.errors).not.toContain("super-secret-value")
    expect(fromFile.errors).not.toContain("chmod 600")
    expect(JSON.parse(fromEnvironment.output).off).toMatchObject({ durationMs: { turn: { medianMs: 7 } } })
    expect(JSON.parse(fromEmptyEnvironment.output).off).toMatchObject({ durationMs: { turn: { medianMs: 70 } } })
  })
})
