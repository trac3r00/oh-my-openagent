import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Advice, PilotMode } from "./decision"

export interface ReportedUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
}

type Observation =
  | { event: "turn_start"; promptHash: string; catalogHash: string; candidateCount: number; threshold: number; timeoutMs: number; descriptionCap?: number; baselineRevision?: string }
  | ({ event: "advice" } & Advice)
  | { event: "catalog"; beforeChars: number; afterChars: number; keptFull: string[]; compacted: number; digestChars: number }
  | { event: "skill_choice"; loadSkills: string[]; selectionTarget: "task" | "parent_read"; category?: string; subagentType?: string }
  | { event: "assistant"; provider?: string; model?: string; usage?: ReportedUsage; firstTextMs: number | null }
  | { event: "turn_end"; durationMs: number; firstTextMs: number | null }

export type PilotRecord = Observation & {
  schemaVersion: 1
  mode: PilotMode
  at: string
  sessionId: string
  turnId: string
}

export function createTelemetry(directory: string, onError: () => void) {
  let tail = Promise.resolve()
  return {
    write(record: PilotRecord): Promise<void> {
      tail = tail
        .then(async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await appendFile(join(directory, `${record.sessionId}.jsonl`), `${JSON.stringify(record)}\n`, {
            mode: 0o600,
          })
        })
        .catch(onError)
      return tail
    },
    flush: () => tail,
  }
}
