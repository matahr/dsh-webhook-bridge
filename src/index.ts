/**
 * dsh-webhook-bridge — generic webhook receiver for DeepSeek Harness.
 *
 * Exposes a local HTTP endpoint; any external system (CI, monitoring, IM
 * services) can POST a message to `/hook/:channel` and wake the harness agent
 * for that channel. One channel maps to one agent session, mirroring the
 * dsh-telegram per-chat model. Zero runtime dependencies beyond the official
 * schema library — `node:http` serves the endpoint.
 *
 * The HTTP surface is separated into `createBridge()` so integration tests can
 * exercise 200/401/400/413 behavior without booting a full harness.
 *
 * @module dsh-webhook-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { timingSafeEqual } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'dsh-webhook-bridge'
export const inject = ['agents', 'sessions']

/** Plugin config: endpoint bind, auth secret, and default agent options. */
export interface WebhookBridgeConfig {
  /** Bind host for the HTTP server. Defaults to loopback only. */
  host: string
  /** Bind port. */
  port: number
  /** Shared secret required in `Authorization: Bearer <secret>`. Empty = reject all. */
  secret: string
  /** Default provider route for created agents. */
  provider?: string
  /** Default model for created agents. */
  model?: string
  /** Working directory for created agents. */
  cwd?: string
  /** Maximum request body size in bytes. */
  maxBodyBytes: number
}

export const Config: Schema<WebhookBridgeConfig> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().default(8788),
  secret: Schema.string().required(),
  provider: Schema.string(),
  model: Schema.string(),
  cwd: Schema.string(),
  maxBodyBytes: Schema.number().default(1_048_576),
})

/** Channel names are constrained to URL-safe short identifiers. */
const CHANNEL_RE = /^[a-zA-Z0-9_-]{1,64}$/

/** One channel mapped to one dsh agent session. */
export interface ChannelSession {
  channel: string
  agent: Agent
  replyUrl?: string
  dispose: () => Promise<void>
}

/** Callbacks the HTTP layer needs; supplied by the plugin `apply`. */
export interface BridgeDeps {
  /** Handle one validated webhook message for a channel. */
  handleMessage: (channel: string, text: string, replyUrl?: string) => Promise<void>
  logger: { warn: (message: string) => void }
}

/** Running bridge: the HTTP server plus a close helper for lifecycle tests. */
export interface Bridge {
  server: Server
  close: () => Promise<void>
}

/** Constant-time secret comparison to avoid timing side channels. */
export function secretsMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Extract message text from a parsed body using the documented precedence. */
export function extractText(body: unknown): string | undefined {
  if (typeof body === 'string') {
    const text = body.trim()
    return text.length > 0 ? text : undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  for (const key of ['message', 'text', 'content'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** Extract an optional reply callback URL from a parsed body. */
export function extractReplyUrl(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)['reply_url']
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Create the HTTP bridge. Pure transport: reads the body, validates auth and
 * channel, and hands the extracted text to `deps.handleMessage`.
 */
export function createBridge(config: WebhookBridgeConfig, deps: BridgeDeps): Bridge {
  const server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, payload: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (req.method === 'GET' && req.url === '/health') {
        send(200, { ok: true })
        return
      }

      if (req.method !== 'POST' || !req.url?.startsWith('/hook/')) {
        send(404, { ok: false, error: 'not_found' })
        return
      }

      const channel = req.url.slice('/hook/'.length).split('?')[0] ?? ''
      if (!CHANNEL_RE.test(channel)) {
        send(400, { ok: false, error: 'invalid_channel' })
        return
      }

      const auth = req.headers.authorization
      const expected = `Bearer ${config.secret}`
      if (config.secret.length === 0 || auth === undefined || !secretsMatch(auth, expected)) {
        send(401, { ok: false, error: 'unauthorized' })
        return
      }

      const chunks: Buffer[] = []
      let size = 0
      let aborted = false
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > config.maxBodyBytes) {
          aborted = true
          return
        }
        if (!aborted) chunks.push(chunk)
      })

      await new Promise<void>((resolve) => {
        req.on('end', () => resolve())
        req.on('close', () => resolve())
        req.on('error', () => resolve())
      })

      if (aborted) {
        send(413, { ok: false, error: 'payload_too_large' })
        return
      }

      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw
      const contentType = req.headers['content-type'] ?? ''
      if (contentType.includes('application/json')) {
        try {
          body = JSON.parse(raw)
        } catch {
          send(400, { ok: false, error: 'invalid_json' })
          return
        }
      }

      const text = extractText(body)
      if (text === undefined) {
        send(400, { ok: false, error: 'empty_message' })
        return
      }
      const replyUrl = extractReplyUrl(body)
      try {
        await deps.handleMessage(channel, text, replyUrl)
        send(200, { ok: true, channel })
      } catch (error: unknown) {
        deps.logger.warn(`dsh-webhook-bridge: ${String(error)}`)
        send(500, { ok: false, error: 'agent_failed' })
      }
    })().catch((error: unknown) => {
      deps.logger.warn(`dsh-webhook-bridge: unexpected error: ${String(error)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'internal' }))
      }
    })
  })

  return {
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}

export function apply(ctx: Context, config: WebhookBridgeConfig): void {
  const agents = ctx.agents
  const logger = ctx.logger
  const sessions = new Map<string, ChannelSession>()

  if (config.secret.length === 0) {
    logger.warn('dsh-webhook-bridge: secret is empty; every request will be rejected. Set DSH_WEBHOOK_SECRET or config.secret.')
  }

  const ensureSession = async (channel: string): Promise<ChannelSession> => {
    const existing = sessions.get(channel)
    if (existing !== undefined) return existing
    const sessionId = SessionId(randomUUID())
    const agentOptions: Record<string, string> = {}
    if (config.provider !== undefined) agentOptions.provider = config.provider
    if (config.model !== undefined) agentOptions.model = config.model
    const handle = await agents.create({
      sessionId,
      meta: { cwd: config.cwd ?? process.cwd() },
      agentOptions,
    })
    const record: ChannelSession = { channel, agent: handle.agent, dispose: () => handle.dispose() }
    sessions.set(channel, record)
    logger.info(`dsh-webhook-bridge: created agent ${sessionId} for channel ${channel}`)
    return record
  }

  /** POST committed assistant text back to the channel's reply URL, if set. */
  const replyTo = (record: ChannelSession, text: string): void => {
    if (record.replyUrl === undefined) return
    void fetch(record.replyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch((error: unknown) => logger.warn(`dsh-webhook-bridge: reply callback failed: ${String(error)}`))
  }

  ctx.on('session/event', (session, event: SessionEvent) => {
    for (const record of sessions.values()) {
      if (record.agent.session !== session) continue
      if (event.type === 'assistant/message') {
        const text = event.data.message.content
          .map((block) => {
            if (block.type === 'text') return block.text
            if (block.type === 'image') return `[image attachment ${block.attachment.attachmentId}]`
            return ''
          })
          .filter((part) => part.length > 0)
          .join('\n')
        if (text.length > 0) replyTo(record, text)
      }
    }
  })

  ctx.on('agent/error', ({ agent, error }) => {
    for (const record of sessions.values()) {
      if (record.agent !== agent) continue
      const message = error instanceof Error ? error.message : String(error)
      replyTo(record, `⚠️ Agent error: ${message}`)
    }
  })

  const bridge = createBridge(config, {
    handleMessage: async (channel, text, replyUrl) => {
      const record = await ensureSession(channel)
      if (replyUrl !== undefined) record.replyUrl = replyUrl
      const userMessage = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      record.agent.followup(userMessage)
    },
    logger,
  })

  ctx.effect(() => {
    bridge.server.listen(config.port, config.host)
    logger.info(`dsh-webhook-bridge: listening on http://${config.host}:${config.port}`)
    return () => {
      void (async () => {
        await bridge.close()
        await Promise.all([...sessions.values()].map((record) => record.dispose()))
        sessions.clear()
      })()
    }
  })
}
