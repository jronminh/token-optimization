// Port of claude-token-optimization (Claude Code PreToolUse/PostToolUse bash
// hooks) to opencode as a single vanilla TypeScript plugin.
//
// Design rules kept from upstream:
//   - warn, never block: nothing throws, permits are untouched, no tool is
//     ever stopped. The cost of a false positive interrupting flow outweighs
//     the missed signal.
//   - quiet unless the point is worth making: exponential backoff on repeats
//     so the identical warning isn't re-injected every time once it's been seen.
//   - never guess numbers we can't measure: only chars/3.5 estimates here; real
//     per-message token usage has no faithful source in the opencode SDK.
//
// Ported 1:1              Claude CC hook          opencode hook
//   reread warn            check-reread.sh         tool.execute.before (read)
//   md-size warn           check-md-size.sh        tool.execute.before (read/edit/write/apply_patch)
//   every-turn rules       claude-md-snippet.md    experimental.chat.system.transform
//
// Warning delivery (important deviation from the first port):
// opencode's `tool.execute.before` output is typed `{ args: any }` - there is
// NO additionalContext/metadata field, so writing output.metadata (what the
// original port did) is a silent no-op. Warnings are instead queued in-process
// and flushed into the next system prompt via experimental.chat.system.transform:
// the model sees them on the next turn, the user sees nothing extra.
//
// Dropped deliberately: context-monitor / check-context.sh - those read REAL
// per-message API usage from the transcript; the opencode SDK Message type has
// no per-message `usage` field, so there's no faithful source for it. Skipped
// rather than faked - same call the original repo made about guessing the
// context window.

import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

export const TokenOptimization: Plugin = async ({
  client,
  project,
  directory,
  worktree,
  $,
}) => {
  // --- state dir: one per session, mirrors the old ~/.claude/session-env ---
  const SESSION_ENV = join(homedir(), ".config", "opencode", "session-env")

  // --- thresholds (same numbers as claude-token-optimization) ---
  const WARN_TOKENS = 12500       // generic .md Read: prefer grep-first past this
  const HARD_TOKENS = 25000       // generic .md Read: never read in full past this
  const WARN_TOKENS_RULES = 1000  // instructions file: injected every turn, tighter cap
  const RULES_FILE = join(homedir(), ".config", "opencode", "environment.md")
  const MANAGED_BEGIN = "<!-- opencode-code-termux-native:begin -->"
  const MANAGED_END = "<!-- opencode-code-termux-native:end -->"

  // In-process warning queue, flushed into output.system next turn.
  const pendingBySession = new Map<string, string[]>()
  let pendingGlobal: string[] = []

  const estTokens = (s: string) => Math.floor([...s].length / 3.5)

  // read tool args key is file_path (snake) on opencode; accept both just in case
  const fileFromArgs = (args: any): string | undefined =>
    args?.file_path ?? args?.filePath ?? args?.path

  const isRulesFile = (file?: string): boolean => {
    if (!file) return false
    return resolve(file) === resolve(RULES_FILE)
  }

  // User-editable portion of the instructions file. The managed
  // opencode-code-termux-native block is installer-maintained, so it must not
  // count toward the every-turn cap (same exclusion the Claude-side hook
  // applies to ~/.claude/CLAUDE.md).
  const userContent = (text: string): string => {
    const out: string[] = []
    let managed = false
    for (const line of text.split(/\r?\n/)) {
      if (line.includes(MANAGED_BEGIN)) { managed = true; continue }
      if (line.includes(MANAGED_END)) { managed = false; continue }
      if (!managed) out.push(line)
    }
    return out.join("\n")
  }

  const queue = (sessionID: string, warning: string): void => {
    if (!warning) return
    if (sessionID) {
      const arr = pendingBySession.get(sessionID) ?? []
      arr.push(warning)
      pendingBySession.set(sessionID, arr)
    } else {
      pendingGlobal.push(warning)
    }
  }

  const log = async (message: string, extra: Record<string, unknown> = {}): Promise<void> => {
    try {
      await client.app.log({
        body: { service: "token-optimization", level: "info", message, extra },
      })
    } catch {
      /* structured logging is best-effort */
    }
  }

  // Warn on the 1st, 2nd, 4th, 8th... occurrence (power of two), not every one.
  const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0
  // Warn on the 2nd, 4th, 8th... repeat of an already-read file (1st read is fine).
  const isPow2Excl0 = (n: number) => n > 1 && isPow2(n)

  const countOf = (dir: string, file: string, key: string): number => {
    try {
      return readFileSync(join(dir, key), "utf8")
        .split("\n")
        .filter((l) => l === file).length
    } catch {
      return 0
    }
  }

  const note = (dir: string, file: string, key: string): void => {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, key), file + "\n")
  }

  // Generic .md read size warning with per-file backoff.
  const maybeQueueMdSize = (sessionID: string, file: string, text: string): void => {
    const tokens = estTokens(text)
    if (tokens < WARN_TOKENS) return
    const dir = join(SESSION_ENV, sessionID)
    const prior = countOf(dir, file, "oversize-warn-log")
    note(dir, file, "oversize-warn-log")
    if (!isPow2(prior + 1)) return
    const warn =
      tokens >= HARD_TOKENS
        ? `'${file}': ~${tokens} est tokens (>= ${HARD_TOKENS}). Do not read it in full - grep -n first, then read just that region.`
        : `'${file}': ~${tokens} est tokens (>= ${WARN_TOKENS}). Prefer grep -n first over reading the whole file.`
    queue(sessionID, warn)
    void log(warn, { sessionID, file, tokens })
  }

  // Every-turn instructions file cap (user-editable content only).
  const maybeQueueRulesCap = (sessionID: string, file: string, text: string): void => {
    const tokens = estTokens(userContent(text))
    if (tokens < WARN_TOKENS_RULES) return
    const warn = `environment.md user content is ~${tokens} est tokens (>= ${WARN_TOKENS_RULES}, injected into EVERY turn). Prefer merging/trimming an existing bullet over appending a new one.`
    queue(sessionID, warn)
    void log(warn, { sessionID, file, tokens })
  }

  // apply_patch carries paths in `patchText` marker lines, not a filePath arg.
  const patchFiles = (patchText: string): string[] => {
    const files: string[] = []
    const re = /^\*\*\* (?:Add|Update|Delete|Move to) File: (.+)$/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(patchText))) {
      const f = m[1].trim()
      if (f) files.push(f)
    }
    return files
  }

  return {
    "tool.execute.before": async (input, output) => {
      const sessionID = input.sessionID
      const args = output.args ?? {}

      if (input.tool === "read") {
        const file = fileFromArgs(args)
        if (!file) return
        const sessionDir = join(SESSION_ENV, sessionID)
        const readLog = join(sessionDir, "read-files-log")

        const prior = countOf(sessionDir, file, "read-files-log")
        note(sessionDir, file, "read-files-log")

        if (prior >= 1 && isPow2Excl0(prior + 1)) {
          const warn = `'${file}': read #${prior + 1} this session by ${sessionID.slice(0, 8)}. Prefer grep -n -A<N> -B<N> <anchor> over a full re-Read.`
          queue(sessionID, warn)
          await log(warn, { sessionID, file })
        }

        if (basename(file).endsWith(".md")) {
          let text = ""
          try {
            text = readFileSync(file, "utf8")
          } catch {
            return
          }
          maybeQueueMdSize(sessionID, file, text)
        }
        return
      }

      if (input.tool === "edit" || input.tool === "write") {
        const file = fileFromArgs(args)
        if (!file || !isRulesFile(file) || !basename(file).endsWith(".md")) return
        let text = ""
        try {
          text = readFileSync(file, "utf8")
        } catch {
          return
        }
        maybeQueueRulesCap(sessionID, file, text)
        return
      }

      if (input.tool === "apply_patch") {
        const patchText = args.patchText
        if (typeof patchText !== "string") return
        for (const file of patchFiles(patchText)) {
          if (!isRulesFile(file) || !basename(file).endsWith(".md")) continue
          let text = ""
          try {
            text = readFileSync(resolve(file), "utf8")
          } catch {
            continue
          }
          maybeQueueRulesCap(sessionID, resolve(file), text)
        }
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      // Every-turn habits, injected each call so they survive compaction.
      const rules = [
        "# Token efficiency (opencode)",
        "- Large files: check size (`ls -la` / `stat -c%s`) before `read`.",
        "  Under 50KB read normally. 50KB+ first `grep -n`/`rg` to locate the",
        "  region, read only that part (this plugin warns live at ~12.5k/25k).",
        "- Repeated reads of the same file within a session: prefer",
        "  `grep -n -A<N> -B<N> <anchor>` over a full re-Read.",
        "- Bash output is the single biggest source of new-content tokens:",
        "  pipe through `| grep`/`| head`/`| tail` when only part is needed.",
        "- Reasoning/output: concise and direct. No restating the question,",
        "  no filler recaps unless depth is asked for.",
      ].join("\n")
      if (!output.system.some((s) => s.includes("# Token efficiency"))) {
        output.system.push(rules)
      }

      // Flush any warnings queued since the last model call - model sees them
      // next turn, queue is cleared so they don't accumulate or duplicate.
      const list = input.sessionID ? (pendingBySession.get(input.sessionID) ?? []) : pendingGlobal
      if (list.length > 0) {
        output.system.push(
          "# Token-efficiency warnings\n" + list.map((w) => `- ${w}`).join("\n")
        )
        list.length = 0
      }
    },
  }
}

export default TokenOptimization