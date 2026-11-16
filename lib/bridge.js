/**
 * Engine bridge: owns one MCP stdio session to the REA engine
 * (`rea-agents mcp`) and exposes `listTools` / `call` to the plugin.
 *
 * Why a hand-rolled JSON-RPC client instead of @modelcontextprotocol/client:
 * REA 6.9.0 declares `outputSchema = { required: ["result"], … }` but returns
 * the *inner* object as `structuredContent`, so the official SDK (which
 * validates every result against the declared output schema) rejects every
 * tools/call with "data must have required property 'result'". Dropping the
 * validator — not the payload — keeps the engine usable, and this file then
 * needs no dependency at all beyond Node builtins.
 *
 * MCP stdio framing is newline-delimited JSON, which is all this client needs.
 */
import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_NAME = 'dsh-rea'
const CLIENT_VERSION = '0.1.0'
const CONNECT_TIMEOUT_MS = 60_000
const MAX_LINE_BYTES = 32 * 1024 * 1024

/** Env names that never reach the engine process. */
const SECRET_NAME = /(key|token|secret|passw|credential|auth|session|cookie)/i

/** Env names kept even though SECRET_NAME would match them. */
const KEEP_ALWAYS = new Set([
  'TERM',
  'USER',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'HOME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'UV_THREADPOOL_SIZE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
])

/**
 * Credential-shaped variables and stale `DSH_*` names are dropped before the
 * engine is spawned: the engine only needs the OS basics, and a reverse
 * engineering session must not inherit harness secrets.
 *
 * @param {Record<string, string | undefined>} extra explicit variables that win
 * @returns {Record<string, string>} the child environment
 */
export function scrubbedEnv(extra = {}) {
  /** @type {Record<string, string>} */
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    if (name.startsWith('DSH_')) continue
    if (!KEEP_ALWAYS.has(name) && SECRET_NAME.test(name)) continue
    env[name] = value
  }
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === 'string') env[name] = value
  }
  return env
}

/**
 * Flatten MCP content blocks into one text body.
 *
 * @param {{ content?: unknown[], structuredContent?: unknown }} result MCP result
 * @returns {string} text for the model
 */
export function resultToText(result) {
  const parts = []
  const blocks = Array.isArray(result?.content) ? result.content : []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') {
      parts.push(String(block))
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'image') {
      const bytes = typeof block.data === 'string' ? Math.round((block.data.length * 3) / 4) : 0
      parts.push(`[image ${block.mimeType ?? 'unknown'}, ${bytes} bytes]`)
      continue
    }
    if (block.type === 'resource') {
      const uri = block.resource?.uri ?? ''
      const text = typeof block.resource?.text === 'string' ? `\n${block.resource.text}` : ''
      parts.push(`[resource ${uri}]${text}`)
      continue
    }
    parts.push(JSON.stringify(block))
  }
  if (result?.structuredContent !== undefined) {
    parts.push(`---\n${JSON.stringify(result.structuredContent, null, 1)}`)
  }
  return parts.join('\n\n')
}

/**
 * Create the engine bridge. Connections are lazy: a failed engine start does
 * not take the plugin down, the next call retries.
 *
 * @param {object} options bridge options
 * @param {string} options.entry absolute path to `rea-agents/scripts/rea.mjs`
 * @param {string} options.cwd working directory for the engine process
 * @param {Record<string, string>} [options.env] extra environment variables
 * @param {number} [options.timeoutMs] per `tools/call` deadline
 * @param {(message: string) => void} [options.log] diagnostics sink
 */
export function createEngineBridge({ entry, cwd, env = {}, timeoutMs = 240_000, log = () => {} }) {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | undefined} */
  let child
  /** @type {Promise<void> | undefined} */
  let connecting
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map()
  /** @type {string} */
  let buffer = ''
  let nextId = 1
  /** @type {any[] | undefined} */
  let catalog
  /** @type {Map<string, any>} */
  let byName = new Map()
  /** @type {string | undefined} */
  let instructions
  /** @type {string | undefined} */
  let lastError
  let closing = false

  function failAll(error) {
    for (const [, entryPending] of pending) {
      clearTimeout(entryPending.timer)
      entryPending.reject(error)
    }
    pending.clear()
  }

  function handleMessage(message) {
    if (message === null || typeof message !== 'object') return
    // A server-initiated request: answer the ones we can, refuse the rest, so
    // the engine never blocks waiting on us.
    if (typeof message.method === 'string' && message.id !== undefined) {
      const reply =
        message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `dsh-rea: ${message.method} is not supported by this client` },
            }
      write(reply)
      return
    }
    if (typeof message.method === 'string') return // notifications
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error !== undefined && message.error !== null) {
      const detail = typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error)
      waiter.reject(new Error(detail))
      return
    }
    waiter.resolve(message.result)
  }

  function consume(chunk) {
    buffer += chunk
    if (buffer.length > MAX_LINE_BYTES) {
      failAll(new Error('dsh-rea: engine sent an oversized message'))
      buffer = ''
      return
    }
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') {
        try {
          handleMessage(JSON.parse(line))
        } catch {
          log(`ignored non-JSON engine output: ${line.slice(0, 200)}`)
        }
      }
      index = buffer.indexOf('\n')
    }
  }

  function write(payload) {
    if (child === undefined || child.killed) throw new Error('dsh-rea: engine process is not running')
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  /**
   * Send one request and wait for its response.
   *
   * @param {string} method JSON-RPC method
   * @param {Record<string, unknown>} params request parameters
   * @param {number} deadlineMs response deadline
   * @param {AbortSignal} [signal] caller cancellation
   */
  function request(method, params, deadlineMs, signal) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error('dsh-rea: cancelled before the engine answered'))
        return
      }
      const timer = setTimeout(() => {
        pending.delete(id)
        write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'dsh-rea deadline' } })
        reject(new Error(`dsh-rea: ${method} did not answer within ${Math.round(deadlineMs / 1000)}s`))
      }, deadlineMs)
      const onAbort = () => {
        pending.delete(id)
        clearTimeout(timer)
        write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'caller cancelled' } })
        reject(new Error('dsh-rea: call cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      try {
        write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function shutdown() {
    closing = true
    failAll(new Error('dsh-rea: engine connection closed'))
    const dying = child
    child = undefined
    if (dying !== undefined) {
      try {
        dying.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    catalog = undefined
    connecting = undefined
  }

  async function connect() {
    if (child !== undefined) return
    if (connecting !== undefined) return connecting
    connecting = (async () => {
      const spawned = spawn(process.execPath, [entry, 'mcp'], {
        cwd,
        env: scrubbedEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child = spawned
      buffer = ''
      closing = false
      spawned.stdout.setEncoding('utf8')
      spawned.stdout.on('data', consume)
      spawned.stderr.setEncoding('utf8')
      spawned.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text !== '') log(`engine: ${text.split('\n').slice(-3).join(' ').slice(0, 500)}`)
      })
      spawned.on('exit', (code, signal) => {
        const reason = `engine exited (code ${code ?? 'null'}${signal === null ? '' : `, signal ${signal}`})`
        lastError = reason
        shutdown()
      })
      spawned.on('error', (error) => {
        lastError = error.message
        log(`engine spawn failed: ${error.message}`)
        failAll(new Error(`dsh-rea: engine spawn failed: ${error.message}`))
      })

      const init = await request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        },
        CONNECT_TIMEOUT_MS,
      )
      if (typeof init?.instructions === 'string') instructions = init.instructions
      write({ jsonrpc: '2.0', method: 'notifications/initialized' })

      const tools = []
      let cursor
      for (let page = 0; page < 50; page += 1) {
        const listed = await request('tools/list', cursor === undefined ? {} : { cursor }, CONNECT_TIMEOUT_MS)
        if (Array.isArray(listed?.tools)) tools.push(...listed.tools)
        cursor = typeof listed?.nextCursor === 'string' && listed.nextCursor !== '' ? listed.nextCursor : undefined
        if (cursor === undefined) break
      }
      catalog = tools
      byName = new Map(tools.map((tool) => [tool.name, tool]))
      lastError = undefined
      connecting = undefined
      log(`engine ready: ${tools.length} tools, protocol ${init?.protocolVersion ?? 'unknown'}`)
    })().catch((error) => {
      connecting = undefined
      lastError = error instanceof Error ? error.message : String(error)
      shutdown()
      throw error
    })
    return connecting
  }

  return {
    /** @returns {Promise<any[]>} the engine's tool catalog */
    async listTools() {
      await connect()
      return catalog ?? []
    },

    /** @returns {string | undefined} server instructions, once known */
    getInstructions() {
      return instructions
    },

    /** @returns {string | undefined} the last connection failure */
    getLastError() {
      return lastError
    },

    /** @returns {any | undefined} one upstream tool definition */
    getTool(name) {
      return byName.get(name)
    },

    /** @returns {boolean} whether the engine session is live */
    isConnected() {
      return child !== undefined && !closing
    },

    /**
     * Invoke one upstream tool. A broken session is dropped so the next call
     * reconnects; the failed call itself is never retried, because a REA tool
     * may already have changed its target.
     *
     * @param {string} name upstream tool name
     * @param {Record<string, unknown>} args tool arguments
     * @param {AbortSignal} [signal] caller cancellation
     * @returns {Promise<{ content: unknown[], structuredContent?: unknown }>} result
     */
    async call(name, args, signal) {
      await connect()
      let result
      try {
        result = await request('tools/call', { name, arguments: args ?? {} }, timeoutMs, signal)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (child === undefined) throw new Error(`REA tool "${name}" failed: engine is not connected (${detail})`)
        throw new Error(`REA tool "${name}" failed: ${detail}`)
      }
      const text = resultToText(result)
      if (result?.isError === true) throw new Error(text === '' ? `REA tool "${name}" reported an error` : text)
      return {
        content: Array.isArray(result?.content) ? result.content : [{ type: 'text', text }],
        ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      }
    },

    /** Close the engine process. */
    async dispose() {
      if (child === undefined) return
      try {
        child.stdin.end()
      } catch {
        /* nothing to flush */
      }
      shutdown()
      await new Promise((resolve) => setTimeout(resolve, 50))
    },
  }
}
