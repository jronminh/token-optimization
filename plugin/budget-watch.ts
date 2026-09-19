import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const INJECT_MARK = "budget-watch-inject"

const CONFIG_FILE = join(homedir(), ".config", "opencode", "budget-watch.json")
const DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
const AUTH_FILE = join(DATA_HOME, "opencode", "auth.json")
const DB_PATH = join(DATA_HOME, "opencode", "opencode.db")
const SESSION_ENV = join(homedir(), ".config", "opencode", "session-env")

const DEFAULTS = {
  provider: "deepseek",
  balanceUrl: "https://api.deepseek.com/user/balance",
  warnAt: 5,
  criticalAt: 2,
  emptyAt: 0.5,
  dailySpendAt: 2,
  recheckMinutes: 5,
  reWarnMinutes: 30,
}

type Config = typeof DEFAULTS

const loadConfig = (): Config => {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) }
  } catch {
    return { ...DEFAULTS }
  }
}

const LABELS = ["OK", "LOW", "CRITICAL", "EMPTY"]

const readApiKey = (provider: string): string | null => {
  try {
    const p = JSON.parse(readFileSync(AUTH_FILE, "utf8"))?.[provider]
    return p?.key ?? p?.apiKey ?? null
  } catch {
    return null
  }
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

const fetchBalance = async (key: string, url: string): Promise<any | null> => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const j: any = await res.json()
    const info = Array.isArray(j?.balance_infos) ? j.balance_infos[0] : null
    if (!info) return null
    return {
      currency: info.currency ?? "USD",
      total: num(info.total_balance),
      toppedUp: num(info.topped_up_balance),
      granted: num(info.granted_balance),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const BudgetWatch: Plugin = async ({ client }) => {
  const cfg = loadConfig()

  let sqlite: any = null
  try {
    sqlite = await import("bun:sqlite")
  } catch {
    sqlite = null
  }

  let cache: { at: number; bal: any } | null = null
  let inflight: Promise<void> | null = null
  let lastLevel = 0
  let lastWarnAt = 0
  let spendCache: { at: number; value: number | null } | null = null
  let dailyWarnDate: string | null = null
  let dailyWarnAt = 0

  const levelOf = (b: number): number =>
    b <= cfg.emptyAt ? 3 : b <= cfg.criticalAt ? 2 : b <= cfg.warnAt ? 1 : 0

  const refresh = (): Promise<void> => {
    if (inflight) return inflight
    if (cache && Date.now() - cache.at < cfg.recheckMinutes * 60_000) {
      return Promise.resolve()
    }
    inflight = (async () => {
      const key = readApiKey(cfg.provider)
      if (!key) return
      const bal = await fetchBalance(key, cfg.balanceUrl)
      if (bal) cache = { at: Date.now(), bal }
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  const todaySpend = (): number | null => {
    if (!sqlite) return null
    try {
      const db = new sqlite.Database(DB_PATH, { readonly: true })
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      // Sum real per-step cost from `part`, not session.cost: session.cost is
      // the whole session's lifetime total, so a session merely *touched* today
      // would count all of its earlier days too (gross overcount).
      const row = db
        .prepare(
          "select coalesce(sum(json_extract(data,'$.cost')),0) as c from part where json_extract(data,'$.type')='step-finish' and time_created>=?",
        )
        .get(d.getTime())
      db.close()
      return row?.c ?? null
    } catch {
      return null
    }
  }

  const getSpend = (): number | null => {
    if (spendCache && Date.now() - spendCache.at < cfg.recheckMinutes * 60_000) {
      return spendCache.value
    }
    const value = todaySpend()
    spendCache = { at: Date.now(), value }
    return value
  }

  const localDate = (): string => {
    const d = new Date()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${d.getFullYear()}-${m}-${day}`
  }

  const dbg = (sessionID: string | undefined, text: string): void => {
    try {
      const dir = join(SESSION_ENV, sessionID || "global")
      mkdirSync(dir, { recursive: true })
      appendFileSync(
        join(dir, "budget-watch.log"),
        `${new Date().toISOString()}\t${text.replace(/\s+/g, " ").trim()}\n`,
      )
    } catch {
      /* best-effort */
    }
  }

  const toast = async (
    message: string,
    variant: "info" | "warning" | "error",
  ): Promise<void> => {
    try {
      await client.tui.showToast({
        body: { title: "budget-watch", message, variant, duration: 10000 },
      })
    } catch {
      /* no TUI attached (headless run) */
    }
  }

  const buildMessage = (bal: any, lvl: number, spend: number | null): string => {
    const lines = [
      `# ${INJECT_MARK}: budget`,
      `${cfg.provider} balance: $${bal.total.toFixed(2)} ${bal.currency} - ${LABELS[lvl]}.`,
      `Thresholds: warn < $${cfg.warnAt}, critical < $${cfg.criticalAt}, empty < $${cfg.emptyAt}; daily spend warning at $${cfg.dailySpendAt}.`,
    ]
    if (spend != null) lines.push(`Spent today across sessions: ~$${spend.toFixed(2)}.`)
    lines.push("Relay this to the user and suggest topping up or reducing usage.")
    return lines.join("\n")
  }

  const buildDailyMessage = (spend: number): string =>
    [
      `# ${INJECT_MARK}: budget`,
      `Daily spend so far: ~$${spend.toFixed(2)} - over the $${cfg.dailySpendAt}/day warning threshold.`,
      "Tell the user their daily budget is exceeded and suggest pausing or reducing usage.",
    ].join("\n")

  return {
    "experimental.chat.system.transform": async (input, output) => {
      await refresh()
      const now = Date.now()

      if (cache) {
        const bal = cache.bal
        const lvl = levelOf(bal.total)
        if (lvl === 0) {
          lastLevel = 0
        } else {
          const crossedDown = lvl > lastLevel
          const stale = now - lastWarnAt > cfg.reWarnMinutes * 60_000
          if (crossedDown || stale) {
            lastLevel = lvl
            lastWarnAt = now
            const spend = getSpend()
            const msg = buildMessage(bal, lvl, spend)
            output.system.push(msg)
            dbg(input.sessionID, msg)
            void toast(
              `${cfg.provider} balance $${bal.total.toFixed(2)} (${LABELS[lvl]})` +
                (spend != null ? ` - spent ~$${spend.toFixed(2)} today` : ""),
              lvl >= 2 ? "error" : "warning",
            )
          }
        }
      }

      const spend = getSpend()
      if (spend != null && spend >= cfg.dailySpendAt) {
        const crossedToday = dailyWarnDate !== localDate()
        const stale = now - dailyWarnAt > cfg.reWarnMinutes * 60_000
        if (crossedToday || stale) {
          dailyWarnDate = localDate()
          dailyWarnAt = now
          const msg = buildDailyMessage(spend)
          output.system.push(msg)
          dbg(input.sessionID, msg)
          void toast(
            `Daily spend ~$${spend.toFixed(2)} (threshold $${cfg.dailySpendAt})`,
            "warning",
          )
        }
      }
    },

    tool: {
      budget_status: tool({
        description:
          "Check the configured LLM provider account balance, today's estimated spend, and the budget-watch warning thresholds.",
        args: {},
        async execute() {
          await refresh()
          const key = readApiKey(cfg.provider)
          if (!key) {
            return `No API key found for provider '${cfg.provider}' in ${AUTH_FILE}.`
          }
          const bal = cache?.bal ?? (await fetchBalance(key, cfg.balanceUrl))
          if (!bal) return "Could not fetch balance (network or API error)."
          cache = { at: Date.now(), bal }
          const spend = getSpend()
          const lvl = levelOf(bal.total)
          return (
            `${cfg.provider} balance: $${bal.total.toFixed(2)} ${bal.currency} ` +
            `(topped-up $${bal.toppedUp.toFixed(2)}, granted $${bal.granted.toFixed(2)}) - ${LABELS[lvl]}.` +
            (spend != null ? ` Spent today: ~$${spend.toFixed(2)}.` : "") +
            ` Thresholds: warn <$${cfg.warnAt}, critical <$${cfg.criticalAt}, empty <$${cfg.emptyAt}; daily spend warning at $${cfg.dailySpendAt}.`
          )
        },
      }),
    },
  }
}

export default BudgetWatch
