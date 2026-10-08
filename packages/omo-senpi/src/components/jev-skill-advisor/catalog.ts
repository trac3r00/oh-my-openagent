/**
 * Pure transformations over the `<available_skills>` block that senpi renders into the system
 * prompt (see senpi `dist/core/skills.js` `formatSkillsForPrompt`). `auto` mode keeps the full
 * entry for the skills Jev ranked and collapses every other entry to `name + location`, so the
 * catalog stops costing descriptions for skills this task will not use while every skill stays
 * reachable by location. No I/O lives here; the component owns reading skill files.
 */

export const CATALOG_ENTRY_COMPACT_NOTE =
  "Entries without a description are still available: read their location when the task calls for them."

export interface CatalogPruneResult {
  prompt: string
  beforeChars: number
  afterChars: number
  keptFull: string[]
  compacted: number
}

interface SkillEntry {
  name: string
  description?: string
  location?: string
  block: string
}

const SKILL_BLOCK = /  <skill>([\s\S]*?)<\/skill>\n/g
const SKILL_NAME = /<name>([\s\S]*?)<\/name>/
const SKILL_DESCRIPTION = /<description>([\s\S]*?)<\/description>/
const SKILL_LOCATION = /<location>([\s\S]*?)<\/location>/
const OPEN = "<available_skills>"
const CLOSE = "</available_skills>"

function parseEntries(section: string): SkillEntry[] {
  const entries: SkillEntry[] = []
  for (const match of section.matchAll(SKILL_BLOCK)) {
    const inner = match[1] ?? ""
    const name = SKILL_NAME.exec(inner)?.[1]
    if (name === undefined) continue
    const description = SKILL_DESCRIPTION.exec(inner)?.[1]
    const location = SKILL_LOCATION.exec(inner)?.[1]
    entries.push({
      name,
      ...(description === undefined ? {} : { description }),
      ...(location === undefined ? {} : { location }),
      block: match[0],
    })
  }
  return entries
}

function compactBlock(entry: SkillEntry): string {
  const lines = ["  <skill>", `    <name>${entry.name}</name>`]
  if (entry.location !== undefined) lines.push(`    <location>${entry.location}</location>`)
  lines.push("  </skill>")
  return lines.join("\n")
}

/**
 * Rewrite the `<available_skills>` block: up to `keepCount` of `keep` (in the caller's rank
 * order) retain their original entry text; every other entry loses its description. Returns
 * `undefined` — meaning "leave the prompt alone" — when the block is absent, carries no
 * entries, or nothing would be pruned. Idempotent: compact entries re-prune to the same bytes.
 */
export function pruneSkillCatalog(
  systemPrompt: string,
  keep: readonly string[],
  keepCount = 5,
): CatalogPruneResult | undefined {
  const open = systemPrompt.indexOf(OPEN)
  const close = systemPrompt.indexOf(CLOSE)
  if (open === -1 || close === -1 || close < open) return undefined
  const section = systemPrompt.slice(open, close + CLOSE.length)
  const entries = parseEntries(section)
  if (entries.length === 0) return undefined

  const fullKeep = new Set(keep.slice(0, Math.max(0, keepCount)))
  const keptFull: string[] = []
  const body: string[] = []
  let compacted = 0
  for (const entry of entries) {
    // Description-free entries pass through unchanged, which is what makes a second run a no-op.
    if (entry.description === undefined || fullKeep.has(entry.name)) {
      if (entry.description !== undefined) keptFull.push(entry.name)
      body.push(entry.block.trimEnd())
      continue
    }
    compacted += 1
    body.push(compactBlock(entry))
  }
  if (compacted === 0) return undefined

  const rewritten = [
    OPEN,
    `  ${CATALOG_ENTRY_COMPACT_NOTE}`,
    ...body,
    CLOSE,
  ].join("\n")
  const prompt = systemPrompt.slice(0, open) + rewritten + systemPrompt.slice(close + CLOSE.length)
  return {
    prompt,
    beforeChars: section.length,
    afterChars: rewritten.length,
    keptFull,
    compacted,
  }
}

export function findSkillLocation(systemPrompt: string, name: string): string | undefined {
  const open = systemPrompt.indexOf(OPEN)
  const close = systemPrompt.indexOf(CLOSE)
  if (open === -1 || close === -1 || close < open) return undefined
  const section = systemPrompt.slice(open, close + CLOSE.length)
  return parseEntries(section).find((entry) => entry.name === name)?.location
}

/** Alias → absolute root, from the prompt's `<skill_roots>` table. */
export function extractSkillRoots(systemPrompt: string): Record<string, string> {
  const open = systemPrompt.indexOf("<skill_roots>")
  const close = systemPrompt.indexOf("</skill_roots>")
  if (open === -1 || close === -1 || close < open) return {}
  const roots: Record<string, string> = {}
  for (const match of systemPrompt.slice(open, close).matchAll(/<(\w+)>([^<]+)<\/\1>/g)) {
    roots[match[1]] = match[2]
  }
  return roots
}

/** `r4/git-master/SKILL.md` + roots → absolute path; `undefined` when the alias is unknown. */
export function resolveSkillFile(location: string, roots: Record<string, string>): string | undefined {
  const slash = location.indexOf("/")
  if (slash <= 0) return undefined
  const root = roots[location.slice(0, slash)]
  if (root === undefined) return undefined
  return `${root}/${location.slice(slash + 1)}`
}

/** Skill body without YAML frontmatter, bounded on a line boundary. */
export function buildSkillDigest(text: string, maxChars = 1200): string | undefined {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
  if (body.length === 0) return undefined
  if (body.length <= maxChars) return body
  const cut = body.slice(0, maxChars)
  const lastBreak = cut.lastIndexOf("\n")
  return `${(lastBreak > maxChars / 2 ? cut.slice(0, lastBreak) : cut).trimEnd()}\n…`
}
