/**
 * DeepSeek Harness plugin: REA (Reverse Engineer Anything) as native tools.
 *
 * The engine is the `rea-agents mcp` server from morluto/rea, shipped as a
 * version-locked dependency of this package and spoken to over MCP stdio by
 * ./bridge.js. Two groups of tools are registered:
 *
 *   1. a curated set (`DEFAULT_DIRECT_TOOLS`) with the engine's own JSON
 *      Schemas, named `rea_<upstream name>`;
 *   2. a gateway — `rea_tools` (search the full catalog) and `rea_call`
 *      (invoke any tool of it) — so nothing is lost by not registering 255
 *      schemas.
 *
 * Registered through `ctx.tools.register` with plain JSON Schema definitions,
 * so no @deepseek-ai/* import is required.
 */
import { mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { createEngineBridge, resultToText } from './bridge.js'
import { DEFAULT_DIRECT_TOOLS } from './catalog.js'

export const name = 'rea'
export const inject = ['tools']

/** Text projection shared by every registered tool. */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      content: { type: 'array', items: {} },
      structuredContent: {},
    },
    required: ['content'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: resultToText(value) }],
}

/** JSON Schema keywords DSH's validator need not see; harmless to drop. */
const DROPPED_SCHEMA_KEYS = new Set(['$schema', '$id', '$comment', '$defs', 'definitions'])
const MAX_REF_DEPTH = 12

/**
 * Inline one `#/$defs/<name>` (or `#/definitions/<name>`) reference, so the
 * provider never sees a `$ref` it has to resolve.
 *
 * @param {string} ref reference string
 * @param {Record<string, unknown>} defs definition table
 * @returns {unknown} the referenced schema, or undefined when unresolvable
 */
function resolveRef(ref, defs) {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)
  if (match === null) return undefined
  const key = decodeURIComponent(match[1]).replace(/~1/g, '/').replace(/~0/g, '~')
  return defs?.[key]
}

/**
 * Normalize an engine JSON Schema into the shape a provider validates.
 *
 * Primitives are preserved verbatim — an `enum` value or a `required` entry is
 * data, not a nested schema. Only schema *objects* are cleaned. Internal `$ref`s
 * are inlined; `$schema`/`$defs` are dropped.
 *
 * @param {unknown} value schema node or plain data inside one
 * @param {Record<string, unknown>} defs definition table of the root schema
 * @param {number} depth ref-inlining depth
 * @returns {unknown} cleaned node
 */
function cleanNode(value, defs, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => cleanNode(item, defs, depth))
  if (value === null || typeof value !== 'object') return value
  if (typeof value.$ref === 'string' && depth < MAX_REF_DEPTH) {
    const target = resolveRef(value.$ref, defs)
    if (target !== undefined && typeof target === 'object') return cleanNode(target, defs, depth + 1)
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (DROPPED_SCHEMA_KEYS.has(key) || key === '$ref') continue
    out[key] = cleanNode(entry, defs, depth)
  }
  return simplify(out)
}

/**
 * Reduce provider-unfriendly constructs to the conservative subset the chat
 * API accepts: `const` becomes a one-value `enum`, `propertyNames` is dropped,
 * and `allOf` branches of plain object schemas are merged into their parent.
 *
 * @param {Record<string, unknown>} schema cleaned schema object
 * @returns {Record<string, unknown>} the same object, normalized
 */
function simplify(schema) {
  if (schema.const !== undefined && schema.enum === undefined) {
    schema.enum = [schema.const]
  }
  delete schema.const
  delete schema.propertyNames
  if (!Array.isArray(schema.allOf)) return schema
  const branches = schema.allOf
  const mergeable = branches.every((branch) => branch !== null && typeof branch === 'object' && branch.type === 'object')
  if (!mergeable) {
    delete schema.allOf
    return schema
  }
  const properties = { ...(schema.properties ?? {}) }
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  for (const branch of branches) {
    Object.assign(properties, branch.properties ?? {})
    for (const name of Array.isArray(branch.required) ? branch.required : []) required.add(name)
  }
  schema.properties = properties
  if (required.size > 0) schema.required = [...required]
  if (schema.type === undefined) schema.type = 'object'
  delete schema.allOf
  return schema
}

/**
 * Sanitize a tool's `inputSchema` for registration.
 *
 * @param {unknown} schema upstream JSON Schema
 * @returns {unknown} cleaned schema (unknown input degrades to an open object)
 */
function sanitizeSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {}, additionalProperties: true }
  }
  const defs =
    schema.$defs !== null && typeof schema.$defs === 'object'
      ? schema.$defs
      : schema.definitions !== null && typeof schema.definitions === 'object'
        ? schema.definitions
        : {}
  const cleaned = cleanNode(schema, defs)
  if (cleaned.type === undefined && cleaned.properties !== undefined) cleaned.type = 'object'
  return cleaned
}

/**
 * Locate the engine entry shipped inside this package.
 *
 * @param {string | undefined} override explicit path from config
 * @returns {string} absolute path to scripts/rea.mjs
 */
function resolveEngineEntry(override) {
  if (typeof override === 'string' && override.trim() !== '') {
    const candidate = isAbsolute(override) ? override : resolve(override)
    if (!existsSync(candidate)) throw new Error(`rea: engine entry not found at ${candidate}`)
    return candidate
  }
  const requireFromHere = createRequire(import.meta.url)
  const manifest = requireFromHere.resolve('rea-agents/package.json')
  const entry = join(dirname(manifest), 'scripts', 'rea.mjs')
  if (!existsSync(entry)) throw new Error(`rea: rea-agents is installed but ${entry} is missing; reinstall the plugin`)
  return entry
}

/**
 * Resolve the engine working directory (artifacts the engine writes land here).
 *
 * @param {string | undefined} override explicit path from config
 * @returns {string} absolute directory
 */
function resolveWorkDir(override) {
  const base =
    typeof override === 'string' && override.trim() !== ''
      ? resolve(override)
      : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'rea')
  mkdirSync(base, { recursive: true })
  return base
}

/**
 * Turn the config's `directTools` into an explicit list.
 *
 * @param {unknown} configured `"default" | "all" | "none" | string[]`
 * @param {any[]} catalog engine tool list
 * @returns {string[]} upstream tool names to register directly
 */
function resolveDirectTools(configured, catalog) {
  const known = new Set(catalog.map((tool) => tool.name))
  if (configured === 'none' || configured === false) return []
  if (configured === 'all' || configured === true) return [...known]
  if (Array.isArray(configured)) {
    return configured
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry !== '' && known.has(entry))
  }
  return DEFAULT_DIRECT_TOOLS.filter((entry) => known.has(entry))
}

/**
 * One argument-less-to-pass-through tool definition mirroring an upstream tool.
 *
 * @param {object} options registration options
 * @param {string} options.publicName model-facing tool name
 * @param {any} options.tool upstream tool definition
 * @param {ReturnType<typeof createEngineBridge>} options.bridge engine bridge
 * @param {number} options.timeoutMs per-call deadline
 */
function directDefinition({ publicName, tool, bridge, timeoutMs }) {
  return {
    name: publicName,
    description: tool.description ?? '',
    parameters: sanitizeSchema(tool.inputSchema),
    output: TEXT_OUTPUT,
    timeoutMs: timeoutMs + 30_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: publicName,
      kind: 'read',
      rawInput: args,
    }),
    async execute(args, exec) {
      const parsed = args !== null && typeof args === 'object' ? args : {}
      return bridge.call(tool.name, parsed, exec?.signal)
    },
  }
}

/**
 * `rea_tools`: discover the catalog without registering 255 schemas.
 *
 * @param {object} options registration options
 * @param {ReturnType<typeof createEngineBridge>} options.bridge engine bridge
 * @param {() => any[]} options.catalog current catalog
 * @param {string} options.prefix direct-registration prefix
 * @param {string[]} options.direct upstream tools registered directly
 */
function catalogTool({ bridge, catalog, prefix, direct }) {
  return {
    name: `${prefix}tools`,
    description:
      'Search the REA reverse-engineering tool catalog (255 tools: native binaries, Mach-O/PE/ELF, managed assemblies, archives and app packages, firmware, JavaScript/Electron bundles, web pages over CDP, Android packages, GDB/frida sessions, evidence export). Returns matching tool names with a one-line summary; pass schema=true for the argument names of one tool. Call the chosen tool through rea_call, or use the directly registered rea_* tools when one fits.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to match against tool names and descriptions (case-insensitive, space = AND). Omit to list everything.',
        },
        limit: { type: 'number', description: 'Maximum rows to return, 1-200. Default 40.' },
        schema: { type: 'boolean', description: 'Include each match\'s required and optional argument names.' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      let tools = catalog()
      if (tools.length === 0) {
        await bridge.listTools()
        tools = catalog()
      }
      const words = typeof args?.query === 'string' ? args.query.toLowerCase().split(/\s+/).filter(Boolean) : []
      const matches = tools.filter((tool) => {
        if (words.length === 0) return true
        const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase()
        return words.every((word) => haystack.includes(word))
      })
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(200, Math.trunc(args.limit))) : 40
      const shown = matches.slice(0, limit)
      const lines = shown.map((tool) => {
        const first = (tool.description ?? '').split(/\n/)[0].trim()
        const directMark = direct.includes(tool.name) ? ' [direct]' : ''
        let line = `- ${tool.name}${directMark}: ${first}`
        if (args?.schema === true) {
          const properties = tool.inputSchema?.properties ?? {}
          const required = new Set(Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [])
          const args = Object.keys(properties).map((key) => (required.has(key) ? `${key}*` : key))
          line += `\n    args: ${args.length === 0 ? '(none)' : args.join(', ')}`
        }
        return line
      })
      const footer =
        matches.length > shown.length
          ? `\n\n${matches.length - shown.length} more match(es); narrow the query or raise limit (max 200).`
          : ''
      const header = `${matches.length} of ${tools.length} REA tools${words.length === 0 ? '' : ` matching "${words.join(' ')}"`}`
      const text = `${header}\n\n${lines.join('\n')}${footer}`
      return { content: [{ type: 'text', text: text === '' ? header : text }] }
    },
  }
}

/**
 * `rea_call`: invoke any catalog tool by name.
 *
 * @param {object} options registration options
 * @param {ReturnType<typeof createEngineBridge>} options.bridge engine bridge
 * @param {string} options.prefix tool-name prefix
 * @param {number} options.timeoutMs per-call deadline
 */
function dispatchTool({ bridge, prefix, timeoutMs }) {
  return {
    name: `${prefix}call`,
    description:
      'Invoke any REA tool from the full catalog by name (discover names with rea_tools). Arguments are passed through unchanged. Use this for the tools that are not registered directly, e.g. decompile_all, inspect_firmware_regions, list_electron_targets, capture_web_screenshot, procedure_pseudo_code with unusual providers. Long analyses can take minutes.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Upstream REA tool name, exactly as listed by rea_tools.' },
        arguments: {
          type: 'object',
          description: 'Argument object for that tool, matching its schema (see rea_tools with schema=true).',
          additionalProperties: true,
        },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: timeoutMs + 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const toolName = typeof args?.tool === 'string' ? args.tool.trim() : ''
      if (toolName === '') throw new Error(`${prefix}call needs a non-empty "tool" name; list names with ${prefix}tools.`)
      const payload =
        args?.arguments !== null && typeof args?.arguments === 'object' && !Array.isArray(args.arguments)
          ? args.arguments
          : {}
      return bridge.call(toolName, payload, exec?.signal)
    },
  }
}

/**
 * Cordis plugin entry.
 *
 * @param {any} ctx plugin context carrying the tools service
 * @param {object} [config] plugin config from the profile patch
 */
export async function apply(ctx, config = {}) {
  const timeoutMs = Number.isFinite(config.toolCallTimeoutMs) ? Math.max(5_000, config.toolCallTimeoutMs) : 240_000
  const prefix = typeof config.toolPrefix === 'string' && config.toolPrefix !== '' ? config.toolPrefix : 'rea_'
  const entry = resolveEngineEntry(config.engineEntry)
  const cwd = resolveWorkDir(config.workdir)

  const bridge = createEngineBridge({
    entry,
    cwd,
    env: config.engineEnv !== null && typeof config.engineEnv === 'object' ? config.engineEnv : {},
    timeoutMs,
    log: (message) => {
      if (typeof ctx.logger?.info === 'function') ctx.logger.info(`[rea] ${message}`)
      else console.error(`[rea] ${message}`)
    },
  })

  ctx.effect(() => () => void bridge.dispose(), 'rea.engine')

  let catalog = []
  try {
    catalog = await bridge.listTools()
  } catch (error) {
    // The engine not starting must not take the harness down: the gateway
    // tools below reconnect on demand, and the failure is reported there.
    const detail = error instanceof Error ? error.message : String(error)
    const note = `REA engine did not start: ${detail}`
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`[rea] ${note}`)
    else console.error(`[rea] ${note}`)
  }

  const direct = catalog.length === 0 ? [] : resolveDirectTools(config.directTools ?? 'default', catalog)
  const registered = []

  for (const toolName of direct) {
    const tool = bridge.getTool(toolName)
    if (tool === undefined) continue
    const publicName = `${prefix}${toolName}`
    try {
      ctx.tools.register(directDefinition({ publicName, tool, bridge, timeoutMs }))
      registered.push(publicName)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[rea] ${publicName} registration skipped: ${detail}`)
    }
  }

  const gateway = [
    catalogTool({ bridge, catalog: () => catalog, prefix, direct }),
    dispatchTool({ bridge, prefix, timeoutMs }),
  ]
  for (const definition of gateway) {
    try {
      ctx.tools.register(definition)
      registered.push(definition.name)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[rea] ${definition.name} registration skipped: ${detail}`)
    }
  }

  const summary = `[rea] ${registered.length} tools registered (engine ${catalog.length === 0 ? 'unavailable at startup' : `${catalog.length} tools`}, workdir ${cwd})`
  if (typeof ctx.logger?.info === 'function') ctx.logger.info(summary)
  else console.error(summary)
}

export const __internals = { sanitizeSchema, resolveEngineEntry, resolveDirectTools, catalogTool, dispatchTool }
