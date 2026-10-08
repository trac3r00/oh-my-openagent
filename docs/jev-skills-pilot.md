# Skills-only Jev pilot (local fork)

This is an opt-in experiment on branch `pilot/jev-skills-v5.1.14-20261004` at the published 5.1.14 release `2afeed86cfbcc0de250321955589e905bcdc0acc` (pinned engine `@code-yeongyu/senpi` 2026.10.5). Keep the released dependency pin instead of chasing unpublished development packages. The trial does not install a global preset, alter normal OmO configuration, replace authentication, or select models, roles, or categories.

## Launch

From this worktree:

```sh
bun script/jev-pilot.ts launch -- [normal OmO args]
bun script/jev-pilot.ts launch --mode off -- [normal OmO args]
bun script/jev-pilot.ts launch --mode advisory --log-dir /path/to/local/logs -- [normal OmO args]
bun script/jev-pilot.ts launch --mode auto --log-dir /path/to/local/logs -- [normal OmO args]
bun script/jev-pilot.ts report
bun script/jev-pilot.ts report --log-dir /path/to/local/logs
```

`launch` defaults to `shadow`. `off` collects comparison telemetry without Jev requests or messages; `shadow` requests advice without injecting it; `advisory` injects ignorable suggestions, leaving the agent's skill choice intact; `auto` applies the advice to the turn itself (see below). The command resolves the fork relative to its own script location, sets `OMO_DEV=1`, `OMO_JEV_PILOT_MODE`, `OMO_JEV_PILOT_BASELINE_REVISION=2afeed86cfbcc0de250321955589e905bcdc0acc`, and `OMO_JEV_PILOT_LOG_DIR`, and passes all other caller environment entries through. Set `OMO_JEV_PILOT_LOG_DIR` for both commands or use `--log-dir` to override it. Without either, logs go under `~/.omo/jev-pilot/logs`. The pilot script does not inspect credentials or print record contents; the fork continues to use its existing authentication, and the report prints aggregates. The extension and fork launcher must be built before launching; missing build artifacts produce an error with a build hint.

The native wrapper prepends this worktree's packaged plugin exactly once. The effective launch is `packages/omo-native/bin/omo.js --no-extensions [args]`; the wrapper supplies its local `packages/omo-native/plugin` as the explicit extension. This disables discovery of installed extensions without changing your normal installation. Build first with `bun run build:omo-native`; the launch check requires the generated `packages/omo-native/plugin/extensions/omo.js`. `-e` and `--extension` in forwarded arguments are rejected so the pilot does not accidentally load a second copy.

Set `TYPESAFE_API_KEY` locally before using a mode that calls Jev - the environment file below keeps it across shells, and a real shell export always wins over the file. Do not paste the key into chat, test fixtures, documentation, or logs. The component defaults to a 1500 ms timeout and 0.8 threshold; `OMO_JEV_PILOT_TIMEOUT_MS` and `OMO_JEV_PILOT_THRESHOLD` override them. `OMO_JEV_PILOT_URL` is for loopback-only QA, not a production endpoint override. Requests exceeding 24,000 state bytes or 48,000 JSON bytes are skipped; these are conservative byte budgets, not token or cache estimates. Session shutdown cancels outstanding shadow work. The 0.8 cutoff is experimental, not a calibrated confidence or accuracy estimate. Use normal `omo` for immediate stock rollback.

## Environment file

`launch` and `report` read an optional environment file at `~/.omo/jev-pilot/.env` before resolving options; `OMO_JEV_PILOT_ENV_FILE` points at a different path. Format is `NAME=value` per line; blank lines, `#` comments, an optional `export ` prefix, and single or double quotes around the value are accepted. Values are literal - no shell expansion and no inline comments.

Only these names are applied: `TYPESAFE_API_KEY`, `OMO_JEV_PILOT_MODE`, `OMO_JEV_PILOT_LOG_DIR`, `OMO_JEV_PILOT_TIMEOUT_MS`, `OMO_JEV_PILOT_THRESHOLD`, `OMO_JEV_PILOT_DESCRIPTION_CAP`. Anything else is reported and ignored, so the file cannot quietly reshape the whole child environment. Real environment variables win over the file, and an explicit `--mode` wins over both. If the file is readable by other users the pilot prints a one-line `chmod 600` reminder; values are never printed.

Store the key there once, from a shell that already holds it:

```sh
printf 'TYPESAFE_API_KEY=%s\n' "$TYPESAFE_API_KEY" >> ~/.omo/jev-pilot/.env
chmod 600 ~/.omo/jev-pilot/.env
```

After that every shell can run `omo-dev` or `bun script/jev-pilot.ts launch` without exporting anything. The file lives outside the repository and is never committed.

## Advisor behavior notes

- The per-skill answers already carry a ranking, so the report and the hidden hint show the best candidate first with its score (`name (0.93)`); no extra question is sent for that.
- Pure acknowledgements (`thanks`, `ok`, `continue`, ...) skip the request entirely with `reason: trivial_prompt`, saving a whole advisor call (~6k input tokens).
- The advice request is a compact state — `Task:`/`Rubric:` lines plus one `id | name | description` line per skill — with one short Noul question per skill (`Does skill sN help this task?`) and per-skill descriptions capped at `OMO_JEV_PILOT_DESCRIPTION_CAP` characters (default 220; `0` disables). Measured 2026-10-04 against the real API (8 labeled scenarios plus a no-skill control, 68-skill catalog): the shipped shape kept the expected suggestion on 8/8 in every sample (mean expected score 0.95; `pr-review` 0.87-0.90) at ~5,000 bench input tokens versus 7,235 for the previous long-form design (-31%); description caps at 160/200 drop `pr-review` below the 0.8 cutoff (0.66/0.78), 240/320 cost more for the same 8/8, ultra-short questions lose it too (0.74-0.75), and an id-free positional state fell to 5/8, so the explicit ids, the 220 cap and the short question stay.
- ### Auto mode (applies the advice to the turn)

`auto` is the only mode that changes what the main model sees. Measured on a live fork session, the `<available_skills>` catalog was 22,174 of 44,115 prompt characters (about 5.7k of roughly 11.3k prompt tokens, ~50%) for 60 skills. `auto` targets exactly that block:

- When advice is `ok`, the component rewrites only the `<available_skills>` block at `before_agent_start`: every skill keeps `name` + `location` with its description dropped, and one line states that description-free entries are still readable by location. Header rules, `<skill_roots>`, and every byte outside the block are untouched.
- The compacted catalog is identical for every task, so the system prompt stays one cacheable prefix across turns and across sessions in the same project. Everything task-specific - the top five ranked skills with their scores and full descriptions - travels in the hidden advice message, after that prefix. An earlier version kept the picks' descriptions inside the system prompt; that made each new session with a different task re-write the ~41k-token prompt cache.
- The top-ranked skill's `SKILL.md` body (frontmatter stripped, bounded to 1200 characters) rides in the hidden advice message, so the skill's procedure is present before the first model call and no read round trip is needed to start.
- Fail-open: `skipped`, `failed`, empty suggestions, a missing catalog block, or an unreadable skill file all leave the prompt and the message exactly as they were. `off`, `shadow`, and `advisory` never touch the system prompt.
- The `catalog` telemetry event records `beforeChars`, `afterChars`, `keptFull`, `compacted`, and `digestChars` per turn, and `report` aggregates them under `catalog` (`savedChars` counts only positive savings).

Rollback is one flag: run with `--mode advisory` (or unset `OMO_JEV_PILOT_MODE`) to return to the untouched catalog.

The report adds `primarySkills` (which skill Jev ranked first per mode) and `estimatedAdviceCostUsd`, computed with the published rate of $42 per billion input tokens (output is free).

## Local event contract and report

Each `.jsonl` record has `schemaVersion: 1`, `event`, `mode` (`off`, `shadow`, `advisory`, `auto`), ISO `at`, and string `sessionId` and `turnId`. The event-specific fields are:

| Event | Fields |
| --- | --- |
| `turn_start` | `promptHash`, `catalogHash`, `candidateCount`, `threshold`, `timeoutMs`, `descriptionCap`, `baselineRevision` |
| `advice` | `status` (`ok`, `skipped`, `failed`), optional `reason`, `durationMs`, `suggestions: string[]` (ranked by score), optional `primary` (highest-confidence suggestion), `scores: {skill, score}[]`, `decisionModel: "jev-1.13.0"`, optional `usage: {input_tokens, output_tokens}`, optional `httpStatus` |
| `skill_choice` | `loadSkills: string[]`, `selectionTarget: "task" | "parent_read"`, optional `category` and `subagentType`; never the task prompt |
| `catalog` | `beforeChars`, `afterChars`, `keptFull`, `compacted`, `digestChars` when `auto` rewrote the skill catalog |
| `assistant` | optional `provider`, `model`, `usage: {input?, output?, cacheRead?, cacheWrite?, totalTokens?}`, plus nullable `firstTextMs` |
| `turn_end` | `durationMs`, nullable `firstTextMs` |

Additional fields are accepted. `null` first-text latency means it was not observed. Missing token fields mean unknown, distinct from observed zero. No raw prompts, task prompts, transcripts, keys, model responses, file bodies, or request bodies belong in these records. Child usage counts only if separate child sessions are actually logged; a parent-only log cannot measure it.

`report` reads only regular `.jsonl` files in the specified directory. An invalid or empty record fails visibly with its file and line, without echoing the record. It groups sessions and turns by mode, counts request outcomes and no-suggestion replies, and separates chosen skill counts by `task` versus `parent_read`. The component logs actual SKILL.md reads mapped from host metadata as `parent_read`, and task `load_skills` as `task`. Suggestion/choice overlap joins by session and turn ID **separately for each target**; each denominator is turns having both successful advice and a recorded choice for that target. It is **overlap, not correctness**. Request and turn duration plus first-text latency show median, p95, and `samples`/`total` coverage; first-text coverage uses completed turns as its denominator. Advice and assistant token totals include only fields actually reported, with `sum: null` when `samples: 0`. `cacheHit` reports prompt cache-hit percentages: `lastRequests` (median and p95 across each session's final observed request) and `sessionPercent` across all observed assistant usage, alongside raw `input`/`cacheRead`/`cacheWrite` sums. Provider/model coverage and per-model token sums refer to logged assistant events, not all possible child calls. These counters are not invoices and make no dollar or savings claim.

Use 3-5 days as a review point. Begin with one day in shadow, then alternate comparable off/advisory sessions for the remainder. Shadow-only data cannot establish cost or latency savings. For off/advisory comparisons, match task type, main model, config, catalog revision, timeout/cutoff, cache conditions, and workload as closely as possible; differences between unlike runs are not causal evidence. Alongside the automatic report, keep manual notes on accepted-task quality, corrections, extra prompts, and the work needed to recover from bad advice. Extend a sparse trial rather than interpreting missing samples as zero. Continue only if completed-task quality holds and cost, elapsed time, or correction burden actually improves on comparable work.

## Data and measured scope

The Jev request contains the current agent-start prompt and loaded skill names/descriptions. The pilot does not independently read SKILL.md bodies; the host may already have expanded a slash-invoked skill or user-supplied context into that prompt, which is then included within the input budget. Logs contain hashes, names, scores, status, timings and reported usage, not raw prompts or keys. First-text and completion timing start at the input hook and end at first text/agent_end; they exclude CLI startup and detached background work. Child usage is unknown unless separately observed in logged sessions. Keep configuration and catalog hashes comparable; selection overlap is not a correctness label.

Setup QA passed seven real local-fixture CLI scenarios plus 35 focused tests and 11 related startup/native-contract tests. The runtime cases cover off/shadow/advisory, none, missing key and actual parent skill reads. These are integration checks, not a live Jev or performance trial. No product commits or upstream posts were made.

Stock CLI/package and original checkout were not replaced. One early failed QA launch used the normal engine directory before the correct OMO_CODING_AGENT_DIR was added. The normal settings file had a same-sized atomic metadata rewrite; its original contents were not captured, so byte-for-byte preservation cannot be asserted. No pilot paths/fixture provider are present, and current settings remained unchanged through correctly isolated QA. Unknown shared settings were not reverted.
