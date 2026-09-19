// Budget optimizer for opencode on Termux.
//
// Sibling to budget-watch.ts (which answers "how much is left?") and
// token-optimization.ts (which warns on wasteful *token* patterns). This one
// answers "where is the money actually going, and can I see the cost before
// I spend it?".
//
// It reuses the same design rules as the other two:
//   - warn, never block: nothing throws, permits untouched.
//   - quiet unless the point is worth making: per-key exponential backoff.
//   - never guess numbers we can't measure: authoritative spend comes from the
//     real per-step `cost`/`tokens` opencode writes into opencode.db; price
//     math is only used for projections and pre-flight estimates, and is
//     labelled as an estimate.
//
// DeepSeek price shape (per 1M tokens, deepseek-flash, off-peak):
//   cache hit $0.003 | cache miss $0.15 | output $0.60
// i.e. new content is 50x a cache hit, and output is 4x a cache miss. Peak
// (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri) doubles every rate. That is what
// the levers below are ordered by.
//
// Injected blocks carry the marker `# budget-optimizer-inject: <kind>` and are
// relayed by the model (see ~/.config/opencode/environment.md); every injection
// is also logged to session-env/<session>/budget-optimizer.log.

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

const INJECT_MARK = "budget-optimizer-inject"

const CONFIG_FILE = join(homedir(), ".config", "opencode", "budget-optimizer.json")
const DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
const AUTH_FILE = join(DATA_HOME, "opencode", "auth.json")
const DB_PATH = join(DATA_HOME, "opencode", "opencode.db")
const SESSION_ENV = join(homedir(), ".config", "opencode", "session-env")

const DEFAULTS = {
  provider: "deepseek",
  balanceUrl: "https://api.deepseek.com/user/balance",
  dailySpendAt: 2,
  budgetModeAt: 3,
  warnOpCost: 0.005,
  warnStepCost: 0.01,
  recheckMinutes: 5,
  reWarnMinutes: 30,
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

// "deepseek-v4-flash" and "deepseek-flash" both bill at the flash rate.
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

export const BudgetOptimizer: Plugin = async ({ client }) => {
  const cfg = loadConfig()

  // bun:sqlite is the fast path inside opencode; node:sqlite is a fallback so
  // the plugin can also be exercised from plain node (tests, one-off reports).
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

  const dbGet = <T = any>(sql: string, params: any[] = []): T | null => {
    const rows = dbAll<T>(sql, params)
    return rows[0] ?? null
  }

  const sessionModelCache = new Map<string, string>()
  const modelOf = (sessionID: string | undefined): string => {
    if (!sessionID) return "deepseek-flash"
    const hit = sessionModelCache.get(sessionID)
    if (hit) return hit
    let id = "deepseek-flash"
    try {
      const row = dbGet<{ model: string }>("select model from session where id=? limit 1", [sessionID])
      const parsed = JSON.parse(row?.model ?? "{}")
      id = parsed?.id ?? id
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
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`
  }

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
      const cr = b.cr * (rate.cacheHit / 1e6)
      const cm = (b.i + b.cw) * (rate.cacheMiss / 1e6)
      const op = (b.o + b.r) * (rate.output / 1e6)
      out.classes.cacheHit += cr
      out.classes.cacheMiss += cm
      out.classes.output += op
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

  // One session's lifetime cost + token classes (authoritative `session.cost`).
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

  const dbg = (sessionID: string | undefined, text: string): void => {
    try {
      const dir = join(SESSION_ENV, sessionID || "global")
      mkdirSync(dir, { recursive: true })
      appendFileSync(
        join(dir, "budget-optimizer.log"),
        `${new Date().toISOString()}\t${text.replace(/\s+/g, " ").trim()}\n`,
      )
    } catch {
      /* best-effort */
    }
  }

  const toast = async (message: string, variant: "info" | "warning" | "error"): Promise<void> => {
    try {
      await client.tui.showToast({ body: { title: "budget-optimizer", message, variant, duration: 8000 } })
    } catch {
      /* no TUI attached */
    }
  }

  const pendingBySession = new Map<string, string[]>()
  const warnCount = new Map<string, number>() // per session+key, for exponential backoff
  const lastWarnAt = new Map<string, number>()

  const shouldWarn = (key: string, cooldownMs: number): boolean => {
    const now = Date.now()
    const last = lastWarnAt.get(key) ?? 0
    if (now - last < cooldownMs) return false
    const n = (warnCount.get(key) ?? 0) + 1
    warnCount.set(key, n)
    if ((n & (n - 1)) !== 0) return false // only on powers of two: 1,2,4,8...
    lastWarnAt.set(key, now)
    return true
  }

  const queue = (sessionID: string | undefined, kind: string, text: string): void => {
    if (!text) return
    const sid = sessionID || "global"
    const arr = pendingBySession.get(sid) ?? []
    arr.push(text)
    pendingBySession.set(sid, arr)
    dbg(sessionID, `${kind}: ${text}`)
    if (kind !== "rules") void toast(text, kind === "mode" ? "warning" : "info")
  }

  const opCost = (sessionID: string | undefined, tokens: number): number => {
    const rate = rateFor(modelOf(sessionID), Date.now())
    return (tokens * rate.cacheMiss) / 1e6
  }

  const cmdSig = (cmd: string): string => cmd.replace(/\s+/g, " ").trim().slice(0, 80)

  const UNBOUNDED =
    /\b(cat|tac|find|tree|du|dmesg|journalctl|env|printenv|strings|xxd|hexdump|base64|tar|unzip|ls)\b/
  const LIMITER = /\|\s*(head|tail|grep|rg|wc|sort|uniq|awk|sed|less|more)\b|>\s*\S|2>&1\s*>/

  const latestStep = (
    sessionID: string,
  ): { cost: number; input: number; output: number; reasoning: number; cacheRead: number } | null => {
    const row = dbGet<{ data: string }>(
      "select data from part where session_id=? and json_extract(data,'$.type')='step-finish' order by time_created desc limit 1",
      [sessionID],
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

  const budgetModeText = (s: Stats): string => {
    const bal = balCache ? `, balance $${balCache.total.toFixed(2)}` : ""
    return [
      `# ${INJECT_MARK}: mode`,
      `BUDGET MODE - spent ~$${s.cost.toFixed(2)} today (${s.steps} steps)${bal}.`,
      `deepseek-flash /1M off-peak: cache-hit $0.003, cache-miss $0.15, output $0.60 (peak doubles).`,
      `Order of leverage: (1) trim tool output - it is new cache-miss input; (2) shorter replies / lower reasoning - output is 4x a cache miss; (3) keep the prefix stable so context stays cache-hit; (4) push heavy work to off-peak (peak = 01-04 & 06-10 UTC Mon-Fri).`,
      `Relay this to the user and prefer the cheaper pattern for the rest of the task.`,
    ].join("\n")
  }

  const modeSeen = new Set<string>()
  const lastModeAt = new Map<string, number>()

  return {
    "chat.params": async (input) => {
      const m: any = (input as any)?.model
      if (input.sessionID && m?.id) {
        sessionModelCache.set(input.sessionID, String(m.id))
      }
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
          "warn",
          `'${file}' is ~${Math.round(tokens / 1000)}k tokens -> ~${fmtUsd(cost)} as new (cache-miss) context. Prefer grep -n / read offset+limit over a full read.`,
        )
        return
      }

      if (input.tool === "bash") {
        const cmd = typeof args?.command === "string" ? args.command : ""
        if (!cmd) return
        if (!UNBOUNDED.test(cmd) || LIMITER.test(cmd)) return
        const sig = cmdSig(cmd)
        if (!shouldWarn(`${sid}|bash|${sig}`, cfg.reWarnMinutes * 60_000)) return
        queue(
          sid,
          "warn",
          `\`${sig}\` may print unbounded output - it lands in context as cache-miss input and is re-sent every later step. Pipe through head/grep/wc, add -n/-m limits, or redirect to a file and grep it.`,
        )
        return
      }

      if (input.tool === "task") {
        if (!shouldWarn(`${sid}|task`, 0)) return
        queue(
          sid,
          "warn",
          `Spawning a subagent builds its own full context and pays its own step costs (often the priciest tool in a session). Keep the subagent's scope tight, or do the work inline when it is small.`,
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
            "warn",
            `Last step cost ${fmtUsd(step.cost)} (in ${step.input}, out ${step.output}, reasoning ${step.reasoning}, cache-read ${step.cacheRead}; output @ ${fmtUsd(rate.output)}/1M). Output + reasoning is the priciest class - trim verbosity/reasoning before trimming context.`,
          )
        }
      } catch {
        /* never let the monitor break a tool call */
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sid = input.sessionID
      await refreshBalance()
      const s = stats()
      const lowBal = !!balCache && balCache.total <= 5
      if (s.cost < cfg.budgetModeAt && !lowBal) return
      const now = Date.now()
      const stale = now - (lastModeAt.get(sid || "global") ?? 0) > cfg.reWarnMinutes * 60_000
      if (modeSeen.has(sid || "global") && !stale) return
      modeSeen.add(sid || "global")
      lastModeAt.set(sid || "global", now)
      const text = budgetModeText(s)
      output.system.push(text)
      dbg(sid, `mode injected:\n${text}`)
    },

    tool: {
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
          const projected = burn * 24
          const lines = [
            `Today (${localDate()}): ${fmtUsd(s.cost)} across ${s.steps} steps.`,
            balCache ? `Balance: $${balCache.total.toFixed(2)} ${balCache.currency}.` : `Balance: unavailable.`,
            `Split (est): cache-miss ${fmtUsd(cls.cacheMiss)} (${pct(cls.cacheMiss)}), cache-hit ${fmtUsd(cls.cacheHit)} (${pct(cls.cacheHit)}), output ${fmtUsd(cls.output)} (${pct(cls.output)}).`,
            `Peak ${fmtUsd(s.peakCost)} / off-peak ${fmtUsd(s.offPeakCost)} (now: ${isPeak(Date.now(), cfg.peakWindowsUtc) ? "PEAK" : "off-peak"}).`,
            `Burn: ${fmtUsd(burn)}/h over ${s.hoursElapsed.toFixed(1)}h active; projected full day ~${fmtUsd(projected)}.`,
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
            `Levers: trim tool output (cache-miss), shorten output/reasoning (4x cache-miss), keep prefix stable (cache-hit), shift heavy work off-peak.`,
          )
          return lines.join("\n")
        },
      }),
    },
  }
}

export default BudgetOptimizer
