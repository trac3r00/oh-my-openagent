import { afterEach, describe, expect, test } from "bun:test"
import { CANDIDATE_GUIDANCE, DECISION_MODEL, DEFAULT_DESCRIPTION_CAP, requestAdvice } from "./decision"

const candidates = [
  { name: "programming", description: "Typed language implementation" },
  { name: "debugging", description: "Diagnose a concrete fault" },
  { name: "spotify", description: "Control music playback" },
]
const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

function fixture(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })
  servers.push(server)
  return server.url.toString()
}

function payload(nouls = [0.95, 0.9, 0.1]) {
  return {
    model: DECISION_MODEL,
    answers: Object.fromEntries(nouls.map((noul, index) => [`s${index}`, { type: "noul", noul }])),
    usage: { input_tokens: 100, output_tokens: 0 },
  }
}

function options(url: string) {
  return { prompt: "Fix a TypeScript crash", candidates, key: "fixture", mode: "advisory" as const, signal: new AbortController().signal, url }
}

describe("Jev skill decision boundary", () => {
  test("off and missing key make no HTTP requests", async () => {
    let calls = 0
    const url = fixture(() => { calls++; return Response.json(payload()) })
    expect((await requestAdvice({ ...options(url), mode: "off" })).reason).toBe("off")
    expect((await requestAdvice({ ...options(url), key: undefined })).reason).toBe("missing_key")
    expect(calls).toBe(0)
  })

  test("one typed request can select multiple candidates and sends no skill bodies", async () => {
    const received = Promise.withResolvers<unknown>()
    const url = fixture(async (request) => {
      received.resolve(await request.json())
      return Response.json(payload())
    })
    const advice = await requestAdvice(options(url))
    const body = await received.promise as { model: string; state: string; questions: Record<string, { type: string; instructions: string }> }
    expect(body.model).toBe(DECISION_MODEL)
    expect(body.state.split("\n")).toEqual([
      "Task: Fix a TypeScript crash",
      `Rubric: ${CANDIDATE_GUIDANCE}`,
      "Skills (id | name | description):",
      ...candidates.map((skill, index) => `s${index} | ${skill.name} | ${skill.description}`),
    ])
    expect(Object.keys(body.questions)).toEqual(["s0", "s1", "s2"])
    expect(Object.values(body.questions).map((question) => question.type)).toEqual(["noul", "noul", "noul"])
    // Each question must name its own candidate id so Jev can map answers back to the state.
    for (const id of ["s0", "s1", "s2"]) expect(body.questions[id]?.instructions).toContain(id)
    expect(advice.status).toBe("ok")
    expect(advice.suggestions).toEqual(["programming", "debugging"])
    expect(advice.primary).toBe("programming")
    expect(advice.usage).toEqual({ input_tokens: 100, output_tokens: 0 })
  })

  test("none is a valid outcome", async () => {
    const url = fixture(() => Response.json(payload([0.1, 0.2, 0.3])))
    const advice = await requestAdvice(options(url))
    expect(advice.suggestions).toEqual([])
    expect(advice.primary).toBeUndefined()
  })

  test("#given a trivial prompt #when requested #then no call is made and real tasks still evaluate", async () => {
    // given
    let calls = 0
    const url = fixture(() => { calls++; return Response.json(payload()) })
    // when / then
    expect((await requestAdvice({ ...options(url), prompt: "Thanks!" })).reason).toBe("trivial_prompt")
    expect(calls).toBe(0)
    expect((await requestAdvice({ ...options(url), prompt: "run tests" })).status).toBe("ok")
    expect(calls).toBe(1)
  })

  test("#given a description cap #when requested #then descriptions are cut at a word boundary while ids and names stay", async () => {
    // given
    const received = Promise.withResolvers<{ state: string }>()
    const url = fixture(async (request) => {
      received.resolve(await request.json() as { state: string })
      return Response.json(payload([0.9, 0.1]))
    })
    const long = [
      { name: "programming", description: `Important context ${"word ".repeat(60)}tail phrase` },
      { name: "debugging", description: "short text" },
    ]
    // when
    await requestAdvice({ ...options(url), candidates: long, descriptionCap: 120 })
    // then
    const lines = ((await received.promise).state as string).split("\n")
    expect(lines[0]).toBe("Task: Fix a TypeScript crash")
    expect(lines[2]).toBe("Skills (id | name | description):")
    const programming = lines.find((line) => line.startsWith("s0 | programming | "))
    expect(programming).toBeDefined()
    expect(programming!.endsWith("…")).toBe(true)
    expect(programming!.length - "s0 | programming | ".length).toBeLessThanOrEqual(121)
    expect(lines).toContain("s1 | debugging | short text")
  })

  test("#given no cap or a zero cap #when requested #then the default applies and zero disables it", async () => {
    // given
    const bodies: string[] = []
    const url = fixture(async (request) => {
      const body = await request.json() as { state: string }
      bodies.push(body.state)
      return Response.json(payload([0.9, 0.1]))
    })
    const long = [{ name: "programming", description: `${"lorem ".repeat(100)}end` }]
    // when
    await requestAdvice({ ...options(url), candidates: long })
    await requestAdvice({ ...options(url), candidates: long, descriptionCap: 0 })
    // then
    const withDefault = bodies[0]!.split("\n").find((line) => line.startsWith("s0 | programming | "))!
    const disabled = bodies[1]!.split("\n").find((line) => line.startsWith("s0 | programming | "))!
    expect(withDefault.endsWith("…")).toBe(true)
    expect(withDefault.length - "s0 | programming | ".length).toBeLessThanOrEqual(DEFAULT_DESCRIPTION_CAP + 1)
    expect(disabled).toBe(`s0 | programming | ${long[0]!.description}`)
  })

  const missingOne = (() => {
    const body = payload()
    delete (body.answers as Record<string, unknown>).s1
    return body
  })()
  test.each([
    { ...payload(), model: "jev-moving-alias" },
    { ...payload(), answers: { ...payload().answers, invented: { type: "noul", noul: 0.95 } } },
    missingOne,
    { ...payload(), answers: { invented: { type: "noul", noul: 0.95 } } },
    { ...payload(), answers: { ...payload().answers, s0: { type: "noul", noul: 1.5 } } },
    { ...payload(), usage: { input_tokens: -1, output_tokens: 0 } },
  ])("rejects invalid model, IDs and usage", async (body) => {
    const advice = await requestAdvice(options(fixture(() => Response.json(body))))
    expect(advice.status).toBe("failed")
    expect(advice.reason).toBe("invalid_response")
    expect(advice.suggestions).toEqual([])
  })

  test("rate limiting preserves an explicit failure without a retry", async () => {
    let calls = 0
    const url = fixture(() => { calls++; return new Response("private body", { status: 429 }) })
    const advice = await requestAdvice(options(url))
    expect(advice).toMatchObject({ status: "failed", reason: "http", httpStatus: 429, suggestions: [] })
    expect(JSON.stringify(advice)).not.toContain("private body")
    expect(calls).toBe(1)
  })

  test("cancellation aborts a real outstanding request", async () => {
    const reached = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    const controller = new AbortController()
    const url = fixture(() => { reached.resolve(); return response.promise })
    const request = requestAdvice({ ...options(url), signal: controller.signal })
    await reached.promise
    controller.abort()
    expect(await request).toMatchObject({ status: "failed", reason: "cancelled", suggestions: [] })
    response.resolve(Response.json(payload()))
  })

  test("the deadline bounds a response that never completes", async () => {
    const response = Promise.withResolvers<Response>()
    const url = fixture(() => response.promise)
    const advice = await requestAdvice({ ...options(url), timeoutMs: 5 })
    expect(advice).toMatchObject({ status: "failed", reason: "timeout", suggestions: [] })
    response.resolve(Response.json(payload()))
  })

  test("no catalog and conservative oversize budgets skip inference", async () => {
    let calls = 0
    const url = fixture(() => { calls++; return Response.json(payload()) })
    expect((await requestAdvice({ ...options(url), candidates: [] })).reason).toBe("no_skills")
    expect((await requestAdvice({ ...options(url), prompt: "x".repeat(24001) })).reason).toBe("input_too_large")
    expect(calls).toBe(0)
  })
})
