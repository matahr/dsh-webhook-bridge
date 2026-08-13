# dsh-webhook-bridge

**Generic webhook receiver for DeepSeek Harness** — POST to a local endpoint and wake a dsh agent. CI, monitoring, or any HTTP-capable service can feed messages to a harness agent over plain HTTP. Zero runtime dependencies beyond the official schema library (`node:http` only).

## Overview

dsh-webhook-bridge exposes a small local HTTP server. Each request to `POST /hook/:channel` delivers a message to that channel's agent session; committed assistant text can be streamed back to an optional callback URL. It is a *protocol driver* in the dsh extension model — the same role as the official ACP/JSON-RPC bridges, but for any system that can send HTTP.

**Who is it for?**

- CI pipelines that want an agent to triage a failed build.
- Monitoring/alerting systems that want an agent to investigate an incident.
- IM bots and webhooks (GitHub, GitLab, generic services) that need to hand a payload to a harness agent.
- Developers who want a readable reference for writing an HTTP-based protocol-driver plugin.

**What it does**

- Serves `POST /hook/:channel` (Bearer-secret auth) and `GET /health`.
- Maps one channel to one agent session; the first message creates the agent, later messages `followup()` into the same session.
- Extracts message text with a documented precedence: JSON `message` > `text` > `content`; non-JSON bodies are used verbatim.
- Optional `reply_url` in the body: committed assistant text is POSTed back as `{"text": "..."}`.
- Rejects unauthorized, malformed, and oversized requests (401/400/413).

**What it does not do (yet)**

- No TLS (terminate TLS at a reverse proxy; the endpoint binds loopback by default).
- No webhook signature verification beyond the shared Bearer secret.
- No cross-restart persistence of channel→session mapping (in-memory; see Compatibility).

## Compatibility

- Requires **Node.js ≥ 22.19** (global `fetch`, `node:http`).
- Built and verified against `@deepseek-ai/dsh@0.1.0-rc.6` / `@deepseek-ai/cordis@^4.0.1`.
- **Last verified:** 2026-08-14.
- Channel→session mapping lives in memory: restarting dsh loses open sessions (a new request recreates them).
- dsh is in developer preview; re-verify after harness updates.

## Install / Uninstall

Install into a dsh profile (local checkout):

```sh
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-webhook-bridge
```

From GitHub (source install — pnpm runs the `prepare` script, so allow it once):

```sh
pnpm dsh plugin --profile web add github:<you>/dsh-webhook-bridge
# pnpm ≥10 blocks the build script on first install; copy the printed package key
# into <profile>/pnpm-workspace.yaml under allowBuilds, then re-run.
```

Uninstall:

```sh
pnpm dsh plugin --profile web remove dsh-webhook-bridge
```

## Quick start

1. Pick a shared secret (e.g. `openssl rand -hex 24`) and set it in the profile's `cordis.patch.yml` (or export `DSH_WEBHOOK_SECRET`):

   ```yaml
   - id: dsh-webhook-bridge
     name: dsh-webhook-bridge
     config:
       secret: 'your-shared-secret'
   ```

2. Start dsh, then deliver a message:

   ```sh
   curl -X POST http://127.0.0.1:8788/hook/ci \
     -H "Authorization: Bearer your-shared-secret" \
     -H "Content-Type: application/json" \
     -d '{"message": "CI failed on main: run the release pipeline diagnosis"}'
   ```

3. To receive the agent's answer back:

   ```sh
   curl -X POST http://127.0.0.1:8788/hook/incident \
     -H "Authorization: Bearer your-shared-secret" \
     -d '{"message": "Investigate the 5xx spike", "reply_url": "https://your-service.example/hook/agent-reply"}'
   ```

## Configuration

All keys live under the `dsh-webhook-bridge` row's `config`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `host` | string | `127.0.0.1` | Bind host. Loopback only by default; bind `0.0.0.0` only behind a firewall/proxy. |
| `port` | number | `8788` | Bind port. |
| `secret` | string | env `DSH_WEBHOOK_SECRET` | Required in `Authorization: Bearer <secret>`. **Empty = every request rejected.** |
| `provider` | string | — | Provider route for created agents (falls back to profile default). |
| `model` | string | — | Model for created agents (falls back to profile default). |
| `cwd` | string | `process.cwd()` | Working directory for created agent sessions. |
| `maxBodyBytes` | number | `1048576` | Request body limit; larger bodies get 413. |

## Permissions & data

- **Network exposure:** the server binds `127.0.0.1` by default. If you bind externally, put it behind a reverse proxy with TLS; the shared secret is the only gate.
- **Auth:** constant-time comparison (`timingSafeEqual`); unauthenticated requests get 401 and never create an agent session.
- **Reply callbacks:** only to an explicit `reply_url` supplied in the request body, restricted to `http:`/`https:`.
- **Filesystem:** the plugin writes nothing; agent sessions inherit the harness workspace policy.
- **Secrets:** never commit the secret to the repository; use the env-var form in the shipped patch.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401` on every request | Wrong/missing `Authorization` header or empty `secret` | Check `config.secret` and the header spelling (`Bearer ` prefix required) |
| `413 payload_too_large` | Body over `maxBodyBytes` | Raise `maxBodyBytes` or send smaller payloads |
| `400 empty_message` | No `message`/`text`/`content` field and empty raw body | Include one of the recognized fields |
| `404 not_found` | Wrong path or method | Use `POST /hook/<channel>`; `/health` is GET only |
| Replies not arriving | No `reply_url` supplied for the channel | Include `reply_url`; the plugin only calls back when one is set |
| Agent error surfaces in logs | Model/provider failure in the harness | Fix the agent composition; the plugin forwards the request as 500 |

## Development

```sh
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run build         # tsc → lib/
pnpm run test          # vitest: HTTP behavior 200/401/400/413 + extraction helpers
```

Structure:

- `src/index.ts` — plugin entry (`name`/`inject`/`Config`/`apply`), session mapping, and `createBridge` (pure HTTP transport, injectable message handler).
- `tests/` — integration tests start a real server on an ephemeral port and assert the HTTP contract without booting a full harness.

Design notes:

- `createBridge(config, deps)` separates transport from agent logic: the HTTP layer is fully unit-testable, and `apply` supplies the `handleMessage` callback that creates sessions and forwards messages.
- Zero runtime dependencies is a goal — `node:http` and `node:crypto` cover everything needed here.

## License & security

MIT. Report security issues privately via the repository's security advisory. The bridge executes no agent code itself; all agent behavior is governed by the harness's own permission and sandbox policy.
