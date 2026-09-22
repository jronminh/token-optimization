// daily-limit.ts - a HARD daily spend cap for opencode.
//
// budget.ts only warns; this plugin blocks. Once the money spent today
// (summed from the step-finish rows in opencode.db, same source budget.ts
// uses) reaches `dailyLimit`, every LLM request whose model is NOT free is
// refused, so no further paid tokens are spent. FREE models/agents are always
// allowed: hitting the cap stops the paid main model, not the free path.
//
// Why not block all tools: blocking `task` would also kill delegation to the
// free-* agents, which cost $0 and are exactly what you want after the cap.
// The cap is about paid spend, so the gate keys on the model's cost, not on
// the tool. (A paid main agent still cannot orchestrate for free - its own
// turns are paid requests - so the free path means switching the main model
// to a free one, or running a free agent.)
//
// Config in ~/.config/opencode/budget.json:
//   { "dailyLimit": 2 }      // USD; 0 or absent disables the cap
// Re-read with a short cache, so the limit can be raised from an editor.
import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG_FILE = join(homedir(), ".config", "opencode", "budget.json")
const DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
const DB_PATH = join(DATA_HOME, "opencode", "opencode.db")
const RECHECK_MS = 30_000

const readLimit = (): number => {
  try {
    const n = Number(JSON.parse(readFileSync(CONFIG_FILE, "utf8"))?.dailyLimit)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

const midnight = (): number => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// A model is free when both input and output cost 0. Unknown cost -> treat as
// free (fail open: never lock the user out on missing data).
const isFreeModel = (model: any): boolean => {
  const c = model?.cost
  if (!c) return true
  return Number(c.input ?? 0) === 0 && Number(c.output ?? 0) === 0
}

export const DailyLimit: Plugin = async ({ client }) => {
  let openDb: (() => any) | null = null
  try {
    const bun: any = await import("bun:sqlite")
    openDb = () => new bun.Database(DB_PATH, { readonly: true })
  } catch {
    try {
      const node: any = await import("node:sqlite")
      openDb = () => new node.DatabaseSync(DB_PATH, { readOnly: true })
    } catch {
      openDb = null
    }
  }

  const q = <T = any>(sql: string, params: any[] = []): T | null => {
    if (!openDb) return null
    try {
      const db = openDb()
      const row = db.prepare(sql).get(...params)
      db.close()
      return (row as T) ?? null
    } catch {
      return null
    }
  }

  const spentToday = (): number =>
    Number(q<any>(`select sum(json_extract(data,'$.cost')) c from part
        where json_extract(data,'$.type')='step-finish' and time_created >= ?`, [midnight()])?.c ?? 0)

  // chat.params is the only hook that sees the model's real cost, so it records
  // which sessions are running a free model; the tool hook consults this set.
  const freeSessions = new Set<string>()

  let cache: { at: number; limit: number; spent: number } | null = null
  const snapshot = (): { limit: number; spent: number } => {
    if (cache && Date.now() - cache.at < RECHECK_MS) return cache
    const limit = readLimit()
    cache = { at: Date.now(), limit, spent: limit > 0 ? spentToday() : 0 }
    return cache
  }

  const breach = (): { spent: number; limit: number } | null => {
    const s = snapshot()
    return s.limit > 0 && s.spent >= s.limit ? { spent: s.spent, limit: s.limit } : null
  }

  const block = (b: { spent: number; limit: number }): Error =>
    new Error(
      `DAILY LIMIT HARD-BLOCK: $${b.spent.toFixed(2)} spent today >= dailyLimit $${b.limit.toFixed(2)} ` +
        `(budget.json). Paid models are refused; free models/agents still run. ` +
        `Raise dailyLimit, switch to a free model, or resume tomorrow.`,
    )

  await client.app.log({
    body: { service: "daily-limit", level: "info", message: `active, dailyLimit=$${snapshot().limit}` },
  })

  return {
    "chat.params": async (input) => {
      if (isFreeModel(input.model)) {
        freeSessions.add(input.sessionID)
        return
      }
      freeSessions.delete(input.sessionID)
      const b = breach()
      if (b) throw block(b)
    },
    "tool.execute.before": async (input, output) => {
      const b = breach()
      if (!b) return
      // delegating to a free agent is always allowed
      if (input.tool === "task" && String(output?.args?.subagent_type ?? "").startsWith("free-")) return
      // a session that chat.params saw running a free model is allowed everything
      if (freeSessions.has(input.sessionID)) return
      await client.app.log({
        body: {
          service: "daily-limit",
          level: "warn",
          message: "hard-blocked a paid session tool call over the daily limit",
          extra: { tool: input.tool, spent: b.spent, limit: b.limit },
        },
      })
      throw block(b)
    },
  }
}
