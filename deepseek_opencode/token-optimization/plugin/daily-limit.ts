// daily-limit.ts - a HARD daily spend cap for opencode.
//
// budget.ts only warns; this plugin blocks. When the money spent today
// (summed from the step-finish rows in opencode.db, same source budget.ts
// uses) reaches `dailyLimit`, every tool call throws, so the agent can make
// no further progress. The model call that requested the tool is already
// paid for, so the stop is not to the cent - but it is a hard stop.
//
// Config lives in ~/.config/opencode/budget.json:
//   { "dailyLimit": 2 }      // USD; 0 or absent disables the cap
// The file is re-read (with a short cache) so the limit can be raised from
// an editor without restarting opencode.
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

  const spentToday = (): number => {
    if (!openDb) return 0
    try {
      const db = openDb()
      const row = db
        .prepare(
          `select sum(json_extract(data,'$.cost')) c from part
           where json_extract(data,'$.type')='step-finish' and time_created >= ?`,
        )
        .get(midnight())
      db.close()
      return Number(row?.c ?? 0)
    } catch {
      return 0
    }
  }

  let cache: { at: number; limit: number; spent: number } | null = null
  const spent = (): number => {
    if (cache && Date.now() - cache.at < RECHECK_MS) return cache.spent
    const limit = readLimit()
    const s = limit > 0 ? spentToday() : 0
    cache = { at: Date.now(), limit, spent: s }
    return s
  }

  const breach = (): number | null => {
    const limit = cache?.limit ?? readLimit()
    if (!(limit > 0)) return null
    const s = spent()
    return s >= limit ? s : null
  }

  const block = (s: number, limit: number): Error =>
    new Error(
      `DAILY LIMIT HARD-BLOCK: $${s.toFixed(2)} spent today >= dailyLimit $${limit.toFixed(2)} ` +
        `(budget.json). No further tool calls are allowed. Raise dailyLimit or resume tomorrow.`,
    )

  return {
    "chat.params": async () => {
      const s = breach()
      if (s !== null) throw block(s, cache!.limit)
    },
    "tool.execute.before": async (input) => {
      const s = breach()
      if (s === null) return
      await client.app.log({
        body: {
          service: "daily-limit",
          level: "warn",
          message: "hard-blocked a tool call over the daily limit",
          extra: { tool: input.tool, spent: s, limit: cache!.limit },
        },
      })
      throw block(s, cache!.limit)
    },
  }
}
