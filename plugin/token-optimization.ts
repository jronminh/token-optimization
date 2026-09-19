// Port of claude-token-optimization (Claude Code PreToolUse/PostToolUse bash
// hooks) to opencode as a single vanilla TypeScript plugin.
//
// Design rules kept from upstream:
//   - warn, never block: nothing throws, permits are untouched, no tool is
//     ever stopped.
//   - quiet unless the point is worth making: exponential backoff on repeats.
//   - never guess numbers we can't measure.
//
// Ported 1:1              Claude CC hook          opencode hook
//   reread warn            check-reread.sh         tool.execute.before (read)
//   md-size warn           check-md-size.sh        tool.execute.before (read/edit/write/apply_patch)
//   context monitor        context-monitor-hook.sh tool.execute.after + session step-finish tokens
//   every-turn rules       claude-md-snippet.md    experimental.chat.system.transform
//
// Two things added beyond the original port:
//   1. CONTEXT MONITOR. The first port dropped this because the opencode SDK
//      Message has no per-message usage. That's true, but the per-step
//      `step-finish` part DOES carry real tokens (input/output/cache). We read
//      the latest one (via bun:sqlite on opencode.db, falling back to the SDK)
//      every CHECK_EVERY tool calls and inject a checkpoint warning, same
//      checkpoint ladder as upstream.
//   2. DEBUG REPORTING. Every injected block starts with the marker
//      `# token-optimization-inject: <kind>` (INJECT_MARK) so the model can
//      recognize it and relay it to the user - the instruction for that lives
//      in ~/.config/opencode/environment.md. Every injection is also written
//      to session-env/<session>/injections.log. A TUI-toast path
//      (client.tui.showToast) is implemented too but DISABLED by default
//      (TOAST_WARNINGS / TOAST_RULES_ONCE = false); flip them on to also see
//      toasts.
//   3. SHORTER RULES COST. The full rules block is injected once per session
//      and again after a compaction; every other turn gets a one-line
//      reminder. Same habits, ~180 tok/turn cheaper.
//
// Warning delivery: opencode's `tool.execute.before` output has no
// additionalContext field, so warnings are queued in-process and flushed into
// the next system prompt via experimental.chat.system.transform.

import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

export const TokenOptimization: Plugin = async ({
  client,
  directory,
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

  // --- context monitor ---
  const CHECK_EVERY = 15          // run the real-token check every Nth tool call
  const CHECKPOINTS = [100000, 200000, 300000, 450000, 600000, 800000,
                       1000000, 1300000, 1600000, 2000000]
  const DB_PATH = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
                       "opencode", "opencode.db")

  // --- debug reporting ---
  // Toasts are implemented but OFF by default (user request): the model
  // relays injected blocks to the user instead, keyed on INJECT_MARK below.
  // Flip either to true to also surface them as TUI toasts.
  const TOAST_RULES_ONCE = false  // toast the every-turn rules block once per session
  const TOAST_WARNINGS = false    // toast each warning/checkpoint when generated
  const TOAST_DURATION = 8000

  // Standardized marker every injected block starts with, so the model can
  // recognize plugin-injected context immediately and relay it (the
  // instruction lives in ~/.config/opencode/environment.md). Changing this
  // string means updating that instruction too.
  const INJECT_MARK = "token-optimization-inject"

  // Rules text. The full block is verbose, so it is injected once per session
  // and again right after a compaction (so the habits survive the context
  // reset); every other turn gets the short one-liner. Both carry INJECT_MARK.
  const RULES_FULL = [
    `# ${INJECT_MARK}: rules`,
    "# Token efficiency (opencode)",
    "- Large files: check size (`ls -la` / `stat -c%s`) before `read`.",
    "  Under 50KB read normally. 50KB+ first `grep -n`/`rg` to locate the",
    "  region, then `read` only that part (this plugin warns at ~12.5k/25k).",
    "- Repeated reads of the same file: use `read` with offset/limit, or",
    "  `grep -n -A<N> -B<N> <anchor>` - not a full re-Read.",
    "- Bash output is the single biggest source of new-content tokens:",
    "  pipe through `| grep`/`| head`/`| tail` when only part is needed.",
    "- Reasoning/output: concise and direct. No restating the question,",
    "  no filler recaps unless depth is asked for.",
  ].join("\n")
  const RULES_SHORT =
    `# ${INJECT_MARK}: rules - check size before read; grep/offset instead of full re-read; pipe Bash output; be concise.`

  // In-process warning queue, flushed into output.system next turn.
  const pendingBySession = new Map<string, string[]>()
  let pendingGlobal: string[] = []

  // Per-session bookkeeping.
  const callCount = new Map<string, number>()
  const rulesToastDone = new Set<string>()
  const rulesSeen = new Set<string>()      // full block already injected once
  const needsFullRules = new Set<string>() // set after a compaction

  const estTokens = (s: string) => Math.floor([...s].length / 3.5)

  // bun:sqlite is the fast path for reading real tokens (O(1), no full-message
  // transfer). Dynamically imported so an unavailable runtime can't break the
  // whole plugin - we fall back to the SDK.
  let sqlite: any = null
  try {
    sqlite = await import("bun:sqlite")
  } catch {
    sqlite = null
  }

  const fileFromArgs = (args: any): string | undefined =>
    args?.file_path ?? args?.filePath ?? args?.path

  const isRulesFile = (file?: string): boolean => {
    if (!file) return false
    return resolve(file) === resolve(RULES_FILE)
  }

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

  // ---- debug reporting: log file + user-visible toast ----
  const dbgLog = (sessionID: string | undefined, kind: string, text: string): void => {
    try {
      const dir = join(SESSION_ENV, sessionID || "global")
      mkdirSync(dir, { recursive: true })
      const oneLine = text.replace(/\s+/g, " ").trim()
      appendFileSync(join(dir, "injections.log"),
        `${new Date().toISOString()}\t${kind}\t${oneLine}\n`)
    } catch {
      /* best-effort */
    }
  }

  const toast = async (title: string, message: string, variant: "info" | "warning" | "success" | "error"): Promise<void> => {
    try {
      await client.tui.showToast({ body: { title, message, variant, duration: TOAST_DURATION } })
    } catch {
      /* no TUI attached (headless run) - the log still has it */
    }
  }

  const report = (sessionID: string | undefined, kind: string, text: string, showToast: boolean): void => {
    dbgLog(sessionID, kind, text)
    if (showToast) {
      void toast(`token-optimization: ${kind}`, text, kind === "rules" ? "info" : "warning")
    }
    void log(`injected ${kind}: ${text}`, { sessionID, kind })
  }

  const queue = (sessionID: string, kind: string, warning: string): void => {
    if (!warning) return
    if (sessionID) {
      const arr = pendingBySession.get(sessionID) ?? []
      arr.push(warning)
      pendingBySession.set(sessionID, arr)
    } else {
      pendingGlobal.push(warning)
    }
    report(sessionID, kind, warning, TOAST_WARNINGS)
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

  const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0
  const isPow2Excl0 = (n: number) => n > 1 && isPow2(n)

  const countOf = (dir: string, file: string, key: string): number => {
    try {
      return readFileSync(join(dir, key), "utf8").split("\n").filter((l) => l === file).length
    } catch {
      return 0
    }
  }

  const note = (dir: string, file: string, key: string): void => {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, key), file + "\n")
  }

  const maybeQueueMdSize = (sessionID: string, file: string, text: string): void => {
    const tokens = estTokens(text)
    if (tokens < WARN_TOKENS) return
    const dir = join(SESSION_ENV, sessionID)
    const prior = countOf(dir, file, "oversize-warn-log")
    note(dir, file, "oversize-warn-log")
    if (!isPow2(prior + 1)) return
    const warn =
      tokens >= HARD_TOKENS
        ? `'${file}': ~${tokens} est tokens (>= ${HARD_TOKENS}). Do not read it in full - grep -n first, then read just that region (offset/limit).`
        : `'${file}': ~${tokens} est tokens (>= ${WARN_TOKENS}). Prefer grep -n (or read offset/limit) over reading the whole file.`
    queue(sessionID, "md-size", warn)
  }

  const maybeQueueRulesCap = (sessionID: string, file: string, text: string): void => {
    const tokens = estTokens(userContent(text))
    if (tokens < WARN_TOKENS_RULES) return
    const warn = `environment.md user content is ~${tokens} est tokens (>= ${WARN_TOKENS_RULES}, injected into EVERY turn). Prefer merging/trimming an existing bullet over appending a new one.`
    queue(sessionID, "rules-cap", warn)
  }

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

  // ---- real token usage: latest step-finish part for this session ----
  const tokensFromStepFinish = (data: string): number => {
    try {
      const p = JSON.parse(data)
      const t = p?.tokens ?? {}
      return (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    } catch {
      return 0
    }
  }

  const currentContextTokens = async (sessionID: string): Promise<number> => {
    if (sqlite) {
      try {
        const db = new sqlite.Database(DB_PATH, { readonly: true })
        const row = db.prepare(
          "select data from part where session_id=? and json_extract(data,'$.type')='step-finish' order by time_created desc limit 1"
        ).get(sessionID)
        db.close()
        if (row?.data) return tokensFromStepFinish(row.data)
      } catch {
        /* fall through to the SDK */
      }
    }
    try {
      const res: any = await client.session.messages({ path: { id: sessionID } })
      const msgs: any[] = res?.data ?? res ?? []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const parts: any[] = msgs[i]?.parts ?? []
        for (let j = parts.length - 1; j >= 0; j--) {
          const p = parts[j]
          if (p?.type === "step-finish" && p.tokens) {
            const t = p.tokens
            return (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
          }
        }
      }
    } catch {
      /* nothing we can measure */
    }
    return 0
  }

  const maybeContextCheckpoint = async (sessionID: string): Promise<void> => {
    const n = (callCount.get(sessionID) ?? 0) + 1
    callCount.set(sessionID, n)
    if (n % CHECK_EVERY !== 0) return

    const tokens = await currentContextTokens(sessionID)
    if (!tokens) return

    const dir = join(SESSION_ENV, sessionID)
    const cpFile = join(dir, "context-checkpoint")
    let last = 0
    try { last = parseInt(readFileSync(cpFile, "utf8").trim(), 10) || 0 } catch { /* first run */ }

    const crossed = CHECKPOINTS.filter((c) => c > last && tokens >= c)
    if (crossed.length === 0) return
    const cp = crossed[crossed.length - 1]
    try { mkdirSync(dir, { recursive: true }); writeFileSync(cpFile, String(cp)) } catch { /* best-effort */ }

    const msg = `Context just crossed ${Math.round(cp / 1000)}k tokens - current ~${tokens} (input + cache_read). Real API usage; window size can't be derived from here.`
    queue(sessionID, "context", msg)
  }

  return {
    "tool.execute.after": async (input) => {
      const sessionID = input.sessionID
      if (!sessionID) return
      try {
        await maybeContextCheckpoint(sessionID)
      } catch {
        /* never let the monitor break a tool call */
      }
    },

    "tool.execute.before": async (input, output) => {
      const sessionID = input.sessionID
      const args = output.args ?? {}

      if (input.tool === "read") {
        const file = fileFromArgs(args)
        if (!file) return
        const sessionDir = join(SESSION_ENV, sessionID)

        const prior = countOf(sessionDir, file, "read-files-log")
        note(sessionDir, file, "read-files-log")

        if (prior >= 1 && isPow2Excl0(prior + 1)) {
          const warn = `'${file}': read #${prior + 1} this session. Don't full re-Read - use read with offset/limit, or grep -n -A<N> -B<N> <anchor>.`
          queue(sessionID, "reread", warn)
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
      const sessionID = input.sessionID

      // Rules: full block once per session (and again after a compaction),
      // short one-liner otherwise. The short line is re-added every turn, so
      // it still survives compaction - without paying the full block's
      // ~180 tok/turn.
      if (!output.system.some((s) => s.includes(`${INJECT_MARK}: rules`))) {
        const useFull = !!sessionID && (!rulesSeen.has(sessionID) || needsFullRules.has(sessionID))
        const block = useFull ? RULES_FULL : RULES_SHORT
        output.system.push(block)
        if (sessionID) {
          rulesSeen.add(sessionID)
          needsFullRules.delete(sessionID)
        }
        const first = !!sessionID && !rulesToastDone.has(sessionID)
        if (sessionID) rulesToastDone.add(sessionID)
        report(sessionID, "rules",
          useFull ? `injected full rules block:\n${block}` : `injected short rules line`,
          first && TOAST_RULES_ONCE)
      }

      // Flush warnings queued since the last model call.
      const list = sessionID ? (pendingBySession.get(sessionID) ?? []) : pendingGlobal
      if (list.length > 0) {
        output.system.push(
          `# ${INJECT_MARK}: warnings\n` + list.map((w) => `- ${w}`).join("\n")
        )
        dbgLog(sessionID, "flush", `${list.length} warning(s): ${list.join(" | ")}`)
        list.length = 0
      }
    },

    "experimental.session.compacting": async (input) => {
      // Context is about to be summarized away - re-inject the full rules
      // block on the next turn so the habits survive the reset.
      if (input.sessionID) needsFullRules.add(input.sessionID)
    },
  }
}

export default TokenOptimization
