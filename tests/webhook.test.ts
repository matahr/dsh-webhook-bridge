import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createBridge, extractReplyUrl, extractText, secretsMatch, type Bridge, type BridgeDeps } from '../src/index.js'

interface Started {
  bridge: Bridge
  base: string
  received: { channel: string; text: string; replyUrl?: string }[]
}

async function startBridge(secret = 'test-secret'): Promise<Started> {
  const received: Started['received'] = []
  const deps: BridgeDeps = {
    handleMessage: async (channel, text, replyUrl) => {
      received.push({ channel, text, replyUrl })
    },
    logger: { warn: () => undefined },
  }
  const bridge = createBridge({ host: '127.0.0.1', port: 0, secret, maxBodyBytes: 1024 }, deps)
  await new Promise<void>((resolve) => bridge.server.listen(0, '127.0.0.1', resolve))
  const address = bridge.server.address() as AddressInfo
  return { bridge, base: `http://127.0.0.1:${address.port}`, received }
}

const active: Started[] = []

afterEach(async () => {
  while (active.length > 0) {
    const started = active.pop()
    if (started !== undefined) await started.bridge.close()
  }
})

async function post(base: string, path: string, body: unknown, secret?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret !== undefined) headers.authorization = `Bearer ${secret}`
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('createBridge', () => {
  it('accepts an authorized JSON message and forwards it', async () => {
    const s = await startBridge()
    active.push(s)
    const res = await post(s.base, '/hook/ci', { message: 'run the release pipeline' }, 'test-secret')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, channel: 'ci' })
    expect(s.received).toHaveLength(1)
    expect(s.received[0]).toEqual({ channel: 'ci', text: 'run the release pipeline', replyUrl: undefined })
  })

  it('supports text and content fields with precedence message > text > content', async () => {
    const s = await startBridge()
    active.push(s)
    await post(s.base, '/hook/a', { text: 'from text' }, 'test-secret')
    await post(s.base, '/hook/b', { content: 'from content' }, 'test-secret')
    expect(s.received.map((r) => [r.channel, r.text])).toEqual([
      ['a', 'from text'],
      ['b', 'from content'],
    ])
  })

  it('accepts a raw string body for non-JSON content', async () => {
    const s = await startBridge()
    active.push(s)
    const res = await fetch(`${s.base}/hook/raw`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'text/plain' },
      body: 'just some text',
    })
    expect(res.status).toBe(200)
    expect(s.received[0]).toEqual({ channel: 'raw', text: 'just some text', replyUrl: undefined })
  })

  it('carries reply_url through to the handler', async () => {
    const s = await startBridge()
    active.push(s)
    await post(s.base, '/hook/cb', { message: 'hi', reply_url: 'https://example.com/cb' }, 'test-secret')
    expect(s.received[0]?.replyUrl).toBe('https://example.com/cb')
  })

  it('rejects missing or wrong secret with 401', async () => {
    const s = await startBridge()
    active.push(s)
    expect((await post(s.base, '/hook/ci', { message: 'x' })).status).toBe(401)
    expect((await post(s.base, '/hook/ci', { message: 'x' }, 'wrong-secret')).status).toBe(401)
    expect(s.received).toHaveLength(0)
  })

  it('rejects invalid channel names with 400', async () => {
    const s = await startBridge()
    active.push(s)
    expect((await post(s.base, '/hook/bad%20channel', { message: 'x' }, 'test-secret')).status).toBe(400)
    expect((await post(s.base, '/hook/', { message: 'x' }, 'test-secret')).status).toBe(400)
  })

  it('rejects empty or JSON-malformed bodies with 400', async () => {
    const s = await startBridge()
    active.push(s)
    expect((await post(s.base, '/hook/ci', {}, 'test-secret')).status).toBe(400)
    expect((await post(s.base, '/hook/ci', '{not json', 'test-secret')).status).toBe(400)
  })

  it('rejects oversized bodies with 413', async () => {
    const s = await startBridge()
    active.push(s)
    const big = JSON.stringify({ message: 'x'.repeat(4096) })
    const res = await fetch(`${s.base}/hook/big`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: big,
    })
    expect(res.status).toBe(413)
  })

  it('serves /health', async () => {
    const s = await startBridge()
    active.push(s)
    const res = await fetch(`${s.base}/health`)
    expect(res.status).toBe(200)
  })
})

describe('extractText', () => {
  it('handles strings, objects, and invalid input', () => {
    expect(extractText(' hello ')).toBe('hello')
    expect(extractText({ message: 'm' })).toBe('m')
    expect(extractText({ content: 'c' })).toBe('c')
    expect(extractText({ text: '' })).toBeUndefined()
    expect(extractText(42)).toBeUndefined()
    expect(extractText(null)).toBeUndefined()
  })
})

describe('extractReplyUrl', () => {
  it('accepts http(s) URLs and rejects everything else', () => {
    expect(extractReplyUrl({ reply_url: 'https://a.example/cb' })).toBe('https://a.example/cb')
    expect(extractReplyUrl({ reply_url: 'file:///etc/passwd' })).toBeUndefined()
    expect(extractReplyUrl({ reply_url: 42 })).toBeUndefined()
    expect(extractReplyUrl({})).toBeUndefined()
  })
})

describe('secretsMatch', () => {
  it('compares exact strings', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true)
    expect(secretsMatch('abc', 'abd')).toBe(false)
    expect(secretsMatch('abc', 'abcd')).toBe(false)
  })
})
