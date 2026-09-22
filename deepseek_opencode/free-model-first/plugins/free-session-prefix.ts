// Prefixes the session title of every free-model trial so the sessions that
// the free-model-first policy spawns are easy to filter in session history.
//
// A trial session is any session whose agent starts with "free-" (both the
// task-tool subagents and `opencode run --agent free-*`). The prefix is
// re-applied if opencode's title generator later rewrites the title.
//
// Cosmetic only: every failure is swallowed so a title never breaks a session.

import type { Plugin } from "@opencode-ai/plugin"

const PREFIX = "[free] "
const FREE_AGENT_PREFIX = "free-"

export const FreeSessionPrefix: Plugin = async ({ client }) => {
  const tagged = new Set<string>()

  const retitle = async (sessionID: string, current?: string) => {
    try {
      let title = current
      if (title === undefined) {
        const res: any = await client.session.get({ path: { id: sessionID } })
        title = res?.data?.title
      }
      if (typeof title !== "string" || title.length === 0 || title.startsWith(PREFIX)) return
      await client.session.update({
        path: { id: sessionID },
        body: { title: PREFIX + title },
      })
    } catch {
      // cosmetic only - never break a session over a title
    }
  }

  return {
    "chat.message": async (input, output) => {
      const agent = input.agent ?? (output?.message as any)?.agent
      if (typeof agent !== "string" || !agent.startsWith(FREE_AGENT_PREFIX)) return
      tagged.add(input.sessionID)
      await retitle(input.sessionID)
    },
    event: async ({ event }) => {
      if (event.type !== "session.updated") return
      const info = event.properties.info
      if (!tagged.has(info.id)) return
      await retitle(info.id, info.title)
    },
  }
}

export default FreeSessionPrefix
