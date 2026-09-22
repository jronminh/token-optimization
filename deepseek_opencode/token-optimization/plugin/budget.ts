// budget.ts - merged balance-watch + budget-optimizer plugin.
//
// One plugin that:
//   - watches the provider balance and today's spend (was budget-watch)
//   - prices each step from opencode.db, warns on oversized reads / unbounded
//     bash / expensive steps, and exposes budget_report (was budget-optimizer)
//   - injects a single detailed budget+token-usage block on a fixed step
//     cadence (default every 15 chat steps) via
//     `experimental.chat.system.transform`.
//
// Injected blocks start with `# budget-inject: <kind>` and are relayed by the
// model (see ~/.config/opencode/environment.md). Every injection is logged to
// session-env/<session>/budget.log.
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const INJECT_MARK = "budget-inject"

const CONFIG_FILE = join(homedir(), ".config", "opencode", "budget.json")
const DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
const AUTH_FILE = join(DATA_HOME, "opencode", "auth.json")
const DB_PATH = join(DATA_HOME, "opencode", "opencode.db")
const SESSION_ENV = join(homedir(), ".config", "opencode", "session-env")

const DEFAULTS = {
  provider: "deepseek",
  balanceUrl: "https://api.deepseek.com/user/balance",
  // balance thresholds
  warnAt: 5,
  criticalAt: 2,
  emptyAt: 0.5,
  // spend thresholds
  dailySpendAt: 2,
  budgetModeAt: 3,
  // per-chat (session) spend guard: caution line, then hard "start a new chat" line
  sessionSpendAt: 0.5,
  sessionSpendCriticalAt: 1,
  warnOpCost: 0.005,
  warnStepCost: 0.01,
  recheckMinutes: 5,
  reWarnMinutes: 30,
  injectEverySteps: 15,
  peakWindowsUtc: [
    [1, 4],
    [6, 10],
  ] as [number, number][],
  prices: {
    "deepseek-flash": { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    "deepseek-v4-pro": { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
  } as Record<string, Rate>,
}

type Rate = { cacheHit: number; cacheMiss: number; output: number }
type Config = typeof DEFAULTS

const loadConfig = (): Config => {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
    return {
      ...DEFAULTS,
      ...raw,
      prices: { ...DEFAULTS.prices, ...(raw?.prices ?? {}) },
      peakWindowsUtc: raw?.peakWindowsUtc ?? DEFAULTS.peakWindowsUtc,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

const readApiKey = (provider: string): string | null => {
  try {
    const p = JSON.parse(readFileSync(AUTH_FILE, "utf8"))?.[provider]
    return p?.key ?? p?.apiKey ?? null
  } catch {
    return null
  }
}

const priceKey = (modelID: string): string =>
  /pro/.test(modelID) ? "deepseek-v4-pro" : "deepseek-flash"

const isPeak = (tsMs: number, windows: [number, number][]): boolean => {
  const d = new Date(tsMs)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = d.getUTCHours()
  return windows.some(([a, b]) => h >= a && h < b)
}

const fmtUsd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`
const LABELS = ["OK", "LOW", "CRITICAL", "EMPTY"]

export const Budget: Plugin = async () => {
  const cfg = loadConfig()

  // ------------------------------------------------------------------ db
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

  const dbAll = <T = any>(sql: string, params: any[] = []): T[] => {
    if (!openDb) return []
    try {
      const db = openDb()
      const rows = db.prepare(sql).all(...params)
      db.close()
      return rows as T[]
    } catch {
      return []
    }
  }

  const dbGet = <T = any>(sql: string, params: any[] = []): T | null =>
    dbAll<T>(sql, params)[0] ?? null

  // ------------------------------------------------------- model & rates
  const sessionModelCache = new Map<string, string>()
  const modelOf = (sessionID: string | undefined): string => {
    if (!sessionID) return "deepseek-flash"
    const hit = sessionModelCache.get(sessionID)
    if (hit) return hit
    let id = "deepseek-flash"
    try {
      const row = dbGet<{ model: string }>("select model from session where id=? limit 1", [sessionID])
      id = JSON.parse(row?.model ?? "{}")?.id ?? id
    } catch {
      /* keep default */
    }
    sessionModelCache.set(sessionID, id)
    return id
  }

  const rateFor = (modelID: string, tsMs: number): Rate => {
    const base = cfg.prices[priceKey(modelID)] ?? cfg.prices["deepseek-flash"]
    return isPeak(tsMs, cfg.peakWindowsUtc)
      ? { cacheHit: base.cacheHit * 2, cacheMiss: base.cacheMiss * 2, output: base.output * 2 }
      : base
  }

  const midnight = (): number => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  const localDate = (): string => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }

  // ----------------------------------------------------------- today stats
  type Bucket = {
    sid: string
    hour: string
    steps: number
    i: number
    o: number
    r: number
    cr: number
    cw: number
    cost: number
  }

  const todayBuckets = (): Bucket[] =>
    dbAll<Bucket>(
      `select session_id sid,
              strftime('%Y-%m-%dT%H', time_created/1000, 'unixepoch') hour,
              count(*) steps,
              sum(json_extract(data,'$.tokens.input')) i,
              sum(json_extract(data,'$.tokens.output')) o,
              sum(json_extract(data,'$.tokens.reasoning')) r,
              sum(json_extract(data,'$.tokens.cache.read')) cr,
              sum(json_extract(data,'$.tokens.cache.write')) cw,
              sum(json_extract(data,'$.cost')) cost
       from part
       where json_extract(data,'$.type')='step-finish' and time_created >= ?
       group by sid, hour`,
      [midnight()],
    )

  type Stats = {
    cost: number
    steps: number
    classes: { cacheHit: number; cacheMiss: number; output: number }
    peakCost: number
    offPeakCost: number
    hoursElapsed: number
  }

  const todayStats = (): Stats => {
    const rows = todayBuckets()
    const out: Stats = {
      cost: 0,
      steps: 0,
      classes: { cacheHit: 0, cacheMiss: 0, output: 0 },
      peakCost: 0,
      offPeakCost: 0,
      hoursElapsed: 0,
    }
    let first: number | null = null
    for (const b of rows) {
      const ts = Date.parse(b.hour + ":00:00Z")
      const rate = rateFor(modelOf(b.sid), ts)
      const peak = isPeak(ts, cfg.peakWindowsUtc)
      out.cost += b.cost
      out.steps += b.steps
      out.classes.cacheHit += b.cr * (rate.cacheHit / 1e6)
      out.classes.cacheMiss += (b.i + b.cw) * (rate.cacheMiss / 1e6)
      out.classes.output += (b.o + b.r) * (rate.output / 1e6)
      if (peak) out.peakCost += b.cost
      else out.offPeakCost += b.cost
      if (first === null || ts < first) first = ts
    }
    out.hoursElapsed = first === null ? 0 : Math.max(1, (Date.now() - first) / 3_600_000)
    return out
  }

  let statsCache: { at: number; value: Stats } | null = null
  const stats = (): Stats => {
    if (statsCache && Date.now() - statsCache.at < cfg.recheckMinutes * 60_000) return statsCache.value
    const value = todayStats()
    statsCache = { at: Date.now(), value }
    return value
  }

  // -------------------------------------------------------- session stats
  type SessionStats = {
    id: string
    title: string | null
    cost: number
    steps: number
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    first: number | null
    last: number | null
  }

  const sessionStats = (sid: string): SessionStats | null => {
    const r = dbGet<any>(
      `select s.id id, s.title title, s.cost cost, count(p.id) steps,
              sum(json_extract(p.data,'$.tokens.input')) input,
              sum(json_extract(p.data,'$.tokens.output')) output,
              sum(json_extract(p.data,'$.tokens.reasoning')) reasoning,
              sum(json_extract(p.data,'$.tokens.cache.read')) cacheRead,
              sum(json_extract(p.data,'$.tokens.cache.write')) cacheWrite,
              min(p.time_created) first, max(p.time_created) last
       from session s
       left join part p on p.session_id = s.id
         and json_extract(p.data,'$.type')='step-finish'
       where s.id = ?
       group by s.id`,
      [sid],
    )
    if (!r) return null
    return {
      id: r.id,
      title: r.title ?? null,
      cost: num(r.cost),
      steps: num(r.steps),
      input: num(r.input),
      output: num(r.output),
      reasoning: num(r.reasoning),
      cacheRead: num(r.cacheRead),
      cacheWrite: num(r.cacheWrite),
      first: r.first ?? null,
      last: r.last ?? null,
    }
  }

  const stepCountOf = (sid: string): number =>
    num(
      dbGet<{ n: number }>(
        "select count(*) as n from part where session_id=? and json_extract(data,'$.type')='step-finish'",
        [sid],
      )?.n,
    )

  const latestStep = (sid: string): { cost: number; input: number; output: number; reasoning: number; cacheRead: number } | null => {
    const row = dbGet<{ data: string }>(
      "select data from part where session_id=? and json_extract(data,'$.type')='step-finish' order by time_created desc limit 1",
      [sid],
    )
    if (!row?.data) return null
    try {
      const p = JSON.parse(row.data)
      const t = p?.tokens ?? {}
      return {
        cost: num(p?.cost),
        input: num(t.input),
        output: num(t.output),
        reasoning: num(t.reasoning),
        cacheRead: num(t?.cache?.read),
      }
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------ balance
  let balCache: { at: number; total: number; currency: string } | null = null
  let balInflight: Promise<void> | null = null
  const refreshBalance = (): Promise<void> => {
    if (balInflight) return balInflight
    if (balCache && Date.now() - balCache.at < cfg.recheckMinutes * 60_000) return Promise.resolve()
    balInflight = (async () => {
      const key = readApiKey(cfg.provider)
      if (!key) return
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10000)
      try {
        const res = await fetch(cfg.balanceUrl, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          signal: ctrl.signal,
        })
        if (!res.ok) return
        const j: any = await res.json()
        const info = Array.isArray(j?.balance_infos) ? j.balance_infos[0] : null
        if (info) balCache = { at: Date.now(), total: num(info.total_balance), currency: info.currency ?? "USD" }
      } catch {
        /* network best-effort */
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => {
      balInflight = null
    })
    return balInflight
  }

  const levelOf = (b: number): number =>
    b <= cfg.emptyAt ? 3 : b <= cfg.criticalAt ? 2 : b <= cfg.warnAt ? 1 : 0

  // ---------------------------------------------------------- logging
  const dbg = (sid: string | undefined, text: string): void => {
    try {
      const dir = join(SESSION_ENV, sid || "global")
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, "budget.log"), `${new Date().toISOString()}\t${text.replace(/\s+/g, " ").trim()}\n`)
    } catch {
      /* best-effort */
    }
  }

  // ---------------------------------------------------------- warnings
  const pendingBySession = new Map<string, string[]>()
  const warnCount = new Map<string, number>()
  const lastWarnAt = new Map<string, number>()

  const shouldWarn = (key: string, cooldownMs: number): boolean => {
    const now = Date.now()
    if (now - (lastWarnAt.get(key) ?? 0) < cooldownMs) return false
    const n = (warnCount.get(key) ?? 0) + 1
    warnCount.set(key, n)
    if ((n & (n - 1)) !== 0) return false // powers of two only: 1,2,4,8...
    lastWarnAt.set(key, now)
    return true
  }

  const queue = (sid: string | undefined, text: string): void => {
    if (!text) return
    const key = sid || "global"
    const arr = pendingBySession.get(key) ?? []
    arr.push(text)
    pendingBySession.set(key, arr)
    dbg(sid, `warn: ${text}`)
  }

  const opCost = (sid: string | undefined, tokens: number): number =>
    (tokens * rateFor(modelOf(sid), Date.now()).cacheMiss) / 1e6

  const lastInjectStep = new Map<string, number>()

  // ------------------------------------------------- session spend guard
  // Escalating, per-chat caution: a long chat re-sends its whole history every
  // step, so its cost grows super-linearly. Warn hard once a chat crosses the
  // caution line and again at the critical line, recommending a fresh chat.
  const sessionSpendTier = new Map<string, number>()
  const sessionSpendWarnedAt = new Map<string, number>()

  const sessionLimitText = (cur: SessionStats, tier: number): string => {
    if (tier <= 0) {
      return [
        `# ${INJECT_MARK}: session-limit`,
        `CAUTION: this chat has spent ${fmtUsd(cur.cost)} across ${cur.steps} steps - over the ${fmtUsd(cfg.sessionSpendAt)} caution line.`,
        `A long chat re-sends its entire history on every step, so each turn costs more than the last.`,
        `Finish the current thought soon, then start a NEW chat for the next task instead of continuing here.`,
        "Relay this caution to the user.",
      ].join("\n")
    }
    return [
      `# ${INJECT_MARK}: session-limit`,
      `STOP AND START A NEW CHAT: this chat has spent ${fmtUsd(cur.cost)} across ${cur.steps} steps - over the ${fmtUsd(cfg.sessionSpendCriticalAt)} hard line.`,
      `Every further step re-bills this whole history; continuing here is the most expensive way to work.`,
      `Open a new chat and paste only what is needed for the next task. Do not keep working in this one.`,
      "Relay this warning to the user and tell them plainly to start a new chat.",
    ].join("\n")
  }

  const sessionLimitWarning = (sid: string | null): string | null => {
    if (!sid) return null
    let cur: SessionStats | null = null
    try {
      cur = sessionStats(sid)
    } catch {
      return null
    }
    if (!cur) return null
    const tier = cur.cost >= cfg.sessionSpendCriticalAt ? 1 : cur.cost >= cfg.sessionSpendAt ? 0 : -1
    if (tier < 0) return null
    const warned = sessionSpendTier.get(sid) ?? -1
    const now = Date.now()
    const last = sessionSpendWarnedAt.get(sid) ?? 0
    // escalate immediately when a new tier is crossed, else respect the cooldown
    if (tier <= warned && now - last < cfg.reWarnMinutes * 60_000) return null
    sessionSpendTier.set(sid, Math.max(warned, tier))
    sessionSpendWarnedAt.set(sid, now)
    return sessionLimitText(cur, tier)
  }

  // ---------------------------------------------------------- injection
  const buildBudgetText = (s: Stats, sid: string | null): string => {
    const cls = s.classes
    const clsTotal = cls.cacheHit + cls.cacheMiss + cls.output || 1
    const pct = (v: number) => `${Math.round((v / clsTotal) * 100)}%`
    const burn = s.steps > 0 && s.hoursElapsed > 0 ? s.cost / s.hoursElapsed : 0
    const lines = [`# ${INJECT_MARK}: budget`]
    if (balCache) {
      const lvl = levelOf(balCache.total)
      lines.push(
        `${cfg.provider} balance: $${balCache.total.toFixed(2)} ${balCache.currency} - ${LABELS[lvl]}. ` +
          `Thresholds: warn < $${cfg.warnAt}, critical < $${cfg.criticalAt}, empty < $${cfg.emptyAt}; daily spend warning at $${cfg.dailySpendAt}.`,
      )
    } else {
      lines.push("Balance: unavailable.")
    }
    lines.push(
      `Today: ${fmtUsd(s.cost)} across ${s.steps} steps (now ${isPeak(Date.now(), cfg.peakWindowsUtc) ? "PEAK" : "off-peak"}); ` +
        `peak ${fmtUsd(s.peakCost)} / off-peak ${fmtUsd(s.offPeakCost)}; burn ${fmtUsd(burn)}/h, projected full day ~${fmtUsd(burn * 24)}.`,
    )
    lines.push(
      `Token split (est): cache-miss ${fmtUsd(cls.cacheMiss)} (${pct(cls.cacheMiss)}), ` +
        `cache-hit ${fmtUsd(cls.cacheHit)} (${pct(cls.cacheHit)}), output ${fmtUsd(cls.output)} (${pct(cls.output)}).`,
    )
    if (sid) {
      const cur = sessionStats(sid)
      if (cur) {
        lines.push(
          `This session: ${fmtUsd(cur.cost)} across ${cur.steps} steps. tokens: cache-miss in ${cur.input}, ` +
            `cache-write ${cur.cacheWrite}, output ${cur.output}, reasoning ${cur.reasoning}, cache-read ${cur.cacheRead}.`,
        )
      }
    }
    lines.push(
      "Levers: trim tool output (cache-miss), shorten output/reasoning (4x cache-miss), keep prefix stable (cache-hit), shift heavy work off-peak.",
    )
    lines.push("Relay this to the user.")
    return lines.join("\n")
  }

  return {
    "chat.params": async (input) => {
      const m: any = (input as any)?.model
      if (input.sessionID && m?.id) sessionModelCache.set(input.sessionID, String(m.id))
    },

    "tool.execute.before": async (input, output) => {
      const sid = input.sessionID
      const args: any = output.args ?? {}

      if (input.tool === "read") {
        const file = args?.file_path ?? args?.filePath ?? args?.path
        if (typeof file !== "string") return
        let size = 0
        try {
          const st = statSync(file)
          if (!st.isFile()) return
          size = st.size
        } catch {
          return
        }
        const tokens = Math.round(size / 4)
        const cost = opCost(sid, tokens)
        if (cost < cfg.warnOpCost) return
        if (!shouldWarn(`${sid}|read|${file}`, cfg.reWarnMinutes * 60_000)) return
        queue(
          sid,
          `'${file}' is ~${Math.round(tokens / 1000)}k tokens -> ~${fmtUsd(cost)} as new (cache-miss) context. Prefer grep -n / read offset+limit over a full read.`,
        )
        return
      }

      if (input.tool === "bash") {
        const cmd = typeof args?.command === "string" ? args.command : ""
        if (!cmd) return
        const UNBOUNDED = /\b(cat|tac|find|tree|du|dmesg|journalctl|env|printenv|strings|xxd|hexdump|base64|tar|unzip|ls)\b/
        const LIMITER = /\|\s*(head|tail|grep|rg|wc|sort|uniq|awk|sed|less|more)\b|>\s*\S|2>&1\s*>/
        if (!UNBOUNDED.test(cmd) || LIMITER.test(cmd)) return
        const sig = cmd.replace(/\s+/g, " ").trim().slice(0, 80)
        if (!shouldWarn(`${sid}|bash|${sig}`, cfg.reWarnMinutes * 60_000)) return
        queue(
          sid,
          `\`${sig}\` may print unbounded output - it lands in context as cache-miss input and is re-sent every later step. Pipe through head/grep/wc, add -n/-m limits, or redirect to a file and grep it.`,
        )
        return
      }

      if (input.tool === "task") {
        if (!shouldWarn(`${sid}|task`, 0)) return
        queue(
          sid,
          "Spawning a subagent builds its own full context and pays its own step costs (often the priciest tool in a session). Keep the subagent's scope tight, or do the work inline when it is small.",
        )
      }
    },

    "tool.execute.after": async (input) => {
      const sid = input.sessionID
      if (!sid) return
      try {
        const step = latestStep(sid)
        if (!step) return
        if (step.cost >= cfg.warnStepCost && shouldWarn(`${sid}|step`, cfg.reWarnMinutes * 60_000)) {
          const rate = rateFor(modelOf(sid), Date.now())
          queue(
            sid,
            `Last step cost ${fmtUsd(step.cost)} (in ${step.input}, out ${step.output}, reasoning ${step.reasoning}, cache-read ${step.cacheRead}; output @ ${fmtUsd(rate.output)}/1M). Output + reasoning is the priciest class - trim verbosity/reasoning before trimming context.`,
          )
        }
      } catch {
        /* never let the monitor break a tool call */
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sid = input.sessionID ?? null
      const key = sid || "global"

      // Session spend guard fires immediately (not gated by the step cadence).
      try {
        const limit = sessionLimitWarning(sid)
        if (limit) {
          output.system.push(limit)
          dbg(sid, `session-limit injected: ${limit.replace(/\s+/g, " ").trim()}`)
        }
      } catch {
        /* never let the guard break a turn */
      }

      // Fixed step cadence (default every 15 chat steps).
      const steps = sid ? stepCountOf(sid) : 0
      if (steps - (lastInjectStep.get(key) ?? 0) < cfg.injectEverySteps) return
      lastInjectStep.set(key, steps)

      try {
        await refreshBalance()
        const text = buildBudgetText(stats(), sid)
        output.system.push(text)
        dbg(sid, `budget injected at step ${steps}:\n${text}`)
      } catch {
        /* never let the plugin break a turn */
      }

      const list = pendingBySession.get(key) ?? []
      if (list.length > 0) {
        output.system.push(`# ${INJECT_MARK}: warnings\n` + list.map((w) => `- ${w}`).join("\n"))
        dbg(sid, `warnings injected: ${list.length}`)
        list.length = 0
      }
    },

    tool: {
      budget_status: tool({
        description:
          "Check the configured LLM provider account balance, today's estimated spend, and the budget warning thresholds.",
        args: {},
        async execute() {
          await refreshBalance()
          const s = stats()
          const bal = balCache
            ? `$${balCache.total.toFixed(2)} ${balCache.currency} - ${LABELS[levelOf(balCache.total)]}`
            : "unavailable"
          return (
            `${cfg.provider} balance: ${bal}. ` +
            `Spent today: ~${fmtUsd(s.cost)} across ${s.steps} steps. ` +
            `Thresholds: warn <$${cfg.warnAt}, critical <$${cfg.criticalAt}, empty <$${cfg.emptyAt}; daily spend warning at $${cfg.dailySpendAt}.`
          )
        },
      }),

      budget_report: tool({
        description:
          "Report real LLM spend from opencode.db: today's authoritative cost, estimated split by token class (cache-hit / cache-miss / output), peak vs off-peak, burn rate, projected full day, top sessions, and this session's own cost + token breakdown.",
        args: {},
        async execute(_args: any, ctx: any) {
          await refreshBalance()
          const s = stats()
          const cls = s.classes
          const clsTotal = cls.cacheHit + cls.cacheMiss + cls.output || 1
          const pct = (v: number) => `${Math.round((v / clsTotal) * 100)}%`
          const burn = s.steps > 0 && s.hoursElapsed > 0 ? s.cost / s.hoursElapsed : 0
          const lines = [
            `Today (${localDate()}): ${fmtUsd(s.cost)} across ${s.steps} steps.`,
            balCache ? `Balance: $${balCache.total.toFixed(2)} ${balCache.currency}.` : "Balance: unavailable.",
            `Split (est): cache-miss ${fmtUsd(cls.cacheMiss)} (${pct(cls.cacheMiss)}), cache-hit ${fmtUsd(cls.cacheHit)} (${pct(cls.cacheHit)}), output ${fmtUsd(cls.output)} (${pct(cls.output)}).`,
            `Peak ${fmtUsd(s.peakCost)} / off-peak ${fmtUsd(s.offPeakCost)} (now: ${isPeak(Date.now(), cfg.peakWindowsUtc) ? "PEAK" : "off-peak"}).`,
            `Burn: ${fmtUsd(burn)}/h over ${s.hoursElapsed.toFixed(1)}h active; projected full day ~${fmtUsd(burn * 24)}.`,
          ]
          const sid = typeof ctx?.sessionID === "string" ? ctx.sessionID : null
          if (sid) {
            const cur = sessionStats(sid)
            if (cur) {
              const name = cur.title ? cur.title.slice(0, 40) : sid.slice(0, 16)
              lines.push(
                `This session (${name}): ${fmtUsd(cur.cost)} across ${cur.steps} steps.`,
                `  tokens: cache-miss in ${cur.input}, cache-write ${cur.cacheWrite}, output ${cur.output}, reasoning ${cur.reasoning}, cache-read ${cur.cacheRead}.`,
              )
            }
          }
          const top = dbAll<{ sid: string; title: string | null; c: number; o: number; r: number; cr: number }>(
            `select p.session_id sid, s.title title,
                    sum(json_extract(p.data,'$.cost')) c,
                    sum(json_extract(p.data,'$.tokens.output')) o,
                    sum(json_extract(p.data,'$.tokens.reasoning')) r,
                    sum(json_extract(p.data,'$.tokens.cache.read')) cr
             from part p left join session s on s.id = p.session_id
             where json_extract(p.data,'$.type')='step-finish' and p.time_created >= ?
             group by p.session_id order by c desc limit 3`,
            [midnight()],
          )
          if (top.length) {
            lines.push(
              `Top sessions: ${top
                .map(
                  (t) =>
                    `${t.title ? t.title.slice(0, 32) : t.sid.slice(0, 12)} ${fmtUsd(t.c)} ` +
                    `(out ${t.o}, reason ${t.r}, cache-read ${t.cr})`,
                )
                .join("; ")}.`,
            )
          }
          lines.push(
            "Levers: trim tool output (cache-miss), shorten output/reasoning (4x cache-miss), keep prefix stable (cache-hit), shift heavy work off-peak.",
          )
          return lines.join("\n")
        },
      }),
    },
  }
}

export default Budget
