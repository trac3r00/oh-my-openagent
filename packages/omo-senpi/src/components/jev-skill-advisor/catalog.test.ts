import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  CATALOG_ENTRY_COMPACT_NOTE,
  buildSkillDigest,
  extractSkillRoots,
  pruneSkillCatalog,
  resolveSkillFile,
} from "./catalog"

// The fixture is rendered by senpi's own prompt formatter, so a formatter change that this
// module cannot parse shows up here instead of silently in a live session.
const senpiDist = dirname(fileURLToPath(import.meta.resolve("@code-yeongyu/senpi")))
const skillsModule = await import(pathToFileURL(join(senpiDist, "core", "skills.js")).href) as {
  formatSkillsForPrompt(skills: Array<{ name: string; description: string; filePath: string }>): string
}

const SKILLS = [
  { name: "git-master", description: "Handle git work: atomic commits, rebase, bisect, blame, reflog, and history questions.", filePath: "/skills/git-master/SKILL.md" },
  { name: "debugging", description: "Runs a hypothesis-driven debugging loop across any language or binary.", filePath: "/skills/debugging/SKILL.md" },
  { name: "spotify", description: "Reads and controls the Spotify desktop app on macOS.", filePath: "/skills/spotify/SKILL.md" },
  { name: "frontend", description: "Builds, styles, and polishes web UI and UX.", filePath: "/skills/frontend/SKILL.md" },
]

const rendered = skillsModule.formatSkillsForPrompt(SKILLS)
const basePrompt = `## Identity\n\nSome preamble.\n${rendered}\n\n## Workstation\n\n- OS: darwin\n`

function section(prompt: string): string {
  const open = prompt.indexOf("<available_skills>")
  const close = prompt.indexOf("</available_skills>") + "</available_skills>".length
  return prompt.slice(open, close)
}

describe("Jev skill-catalog prune", () => {
  test("#given a real formatter section #when two skills rank top #then only those keep descriptions and the rest keep name+location", () => {
    const result = pruneSkillCatalog(basePrompt, ["git-master", "debugging"], 2)
    expect(result).toBeDefined()
    const pruned = result?.prompt ?? ""
    expect(result?.keptFull).toEqual(["git-master", "debugging"])
    expect(result?.compacted).toBe(2)
    expect(result?.beforeChars).toBe(section(basePrompt).length)
    expect(result?.afterChars).toBe(section(pruned).length)
    expect(section(pruned)).toContain(SKILLS[0]?.description ?? "")
    expect(section(pruned)).toContain(SKILLS[1]?.description ?? "")
    expect(section(pruned)).not.toContain(SKILLS[2]?.description ?? "")
    expect(section(pruned)).not.toContain(SKILLS[3]?.description ?? "")
    expect(section(pruned)).toContain("<name>spotify</name>")
    expect(section(pruned)).toContain("<location>r0/spotify/SKILL.md</location>")
    expect(section(pruned)).toContain(CATALOG_ENTRY_COMPACT_NOTE)
    expect(result?.afterChars).toBeLessThan(result?.beforeChars ?? 0)
  })

  test("#given text outside the skills block #when pruning #then every byte outside the block is untouched", () => {
    const pruned = pruneSkillCatalog(basePrompt, ["spotify"], 1)?.prompt ?? ""
    expect(pruned.startsWith(basePrompt.slice(0, basePrompt.indexOf("<available_skills>")))).toBe(true)
    expect(pruned.endsWith("\n\n## Workstation\n\n- OS: darwin\n")).toBe(true)
    expect(pruned).toContain("<skill_roots>")
    expect(pruned).toContain("<r0>/skills</r0>")
  })

  test("#given an already pruned prompt #when pruning again with the same ranking #then nothing changes", () => {
    const once = pruneSkillCatalog(basePrompt, ["git-master"], 1)
    const twice = pruneSkillCatalog(once?.prompt ?? "", ["git-master"], 1)
    expect(twice).toBeUndefined()
    expect(pruneSkillCatalog(once?.prompt ?? "", [], 0)?.compacted).toBe(1)
  })

  test("#given no skills block or nothing to compact #when pruning #then the prompt is left alone", () => {
    expect(pruneSkillCatalog("no catalog here", ["anything"], 5)).toBeUndefined()
    expect(pruneSkillCatalog(basePrompt, SKILLS.map((skill) => skill.name), 5)).toBeUndefined()
    expect(pruneSkillCatalog(rendered, [], 0)?.compacted).toBe(SKILLS.length)
  })

  test("#given the prompt roots table #when resolving a location #then the alias maps to an absolute file and unknown aliases fail open", () => {
    const roots = extractSkillRoots(basePrompt)
    expect(roots).toEqual({ r0: "/skills" })
    expect(resolveSkillFile("r0/git-master/SKILL.md", roots)).toBe("/skills/git-master/SKILL.md")
    expect(resolveSkillFile("r9/git-master/SKILL.md", roots)).toBeUndefined()
    expect(resolveSkillFile("git-master/SKILL.md", roots)).toBeUndefined()
  })

  test("#given a skill file body #when building a digest #then frontmatter is dropped and the body is bounded on a line", () => {
    const digest = buildSkillDigest("---\nname: git-master\ndescription: x\n---\n\n# Git\n\nRule one.\nRule two.\n", 20)
    expect(digest?.startsWith("# Git")).toBe(true)
    expect(digest?.endsWith("…")).toBe(true)
    expect(buildSkillDigest("---\nname: empty\n---\n")).toBeUndefined()
    expect(buildSkillDigest("# Short\n\ntext")).toBe("# Short\n\ntext")
  })
})
