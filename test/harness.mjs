/**
 * Pre-install verification: mount the plugin against a fake Cordis context and
 * exercise the registered definitions exactly the way the harness would.
 *
 * Run: node test/harness.mjs
 */
import { apply, __internals } from '../lib/index.js'
import { resultToText, scrubbedEnv } from '../lib/bridge.js'

/** Minimal Cordis stand-in: records registrations, keeps effects. */
function fakeCtx() {
  const tools = new Map()
  const effects = []
  return {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(setup) {
      effects.push(setup())
    },
    logger: {
      info: (message) => console.error(message),
      warn: (message) => console.error(message),
    },
    toolsMap: tools,
    dispose: async () => {
      for (const disposer of effects) if (typeof disposer === 'function') await disposer()
    },
  }
}

const ctx = fakeCtx()
await apply(ctx, { toolCallTimeoutMs: 120_000 })

const names = [...ctx.toolsMap.keys()]
console.log('\n=== registered tools ===')
console.log(names.join(', '))

const schemaBytes = names.reduce(
  (total, name) => total + JSON.stringify(ctx.toolsMap.get(name).parameters ?? {}).length,
  0,
)
console.log(`\nschema payload: ${(schemaBytes / 1024).toFixed(1)} KiB across ${names.length} tools`)

function render(name, value) {
  const definition = ctx.toolsMap.get(name)
  const text = definition.output.render({}, value)
  return text.map((block) => block.text).join('\n')
}

const exec = { signal: AbortSignal.timeout(180_000) }

console.log('\n=== rea_tools (query=android, schema) ===')
const listing = await ctx.toolsMap
  .get('rea_tools')
  .execute({ query: 'android package', limit: 3, schema: true }, exec)
console.log(render('rea_tools', listing))

console.log('\n=== rea_call(search_guidance) ===')
const guidance = await ctx.toolsMap.get('rea_call').execute(
  { tool: 'search_guidance', arguments: { query: 'binary' } },
  exec,
)
console.log(render('rea_call', guidance).slice(0, 1200))

console.log('\n=== rea_binary_session (direct tool, before open) ===')
try {
  const session = await ctx.toolsMap.get('rea_binary_session').execute({}, exec)
  console.log(render('rea_binary_session', session).slice(0, 800))
} catch (error) {
  console.log('expected error path:', String(error).slice(0, 300))
}

console.log('\n=== scrubbed env sample ===')
const sample = Object.keys(scrubbedEnv({ REA_EXTRA: 'x' }))
console.log('DSH_* leaked:', sample.some((key) => key.startsWith('DSH_')))
console.log('kept HOME:', sample.includes('HOME'), '| extra:', sample.includes('REA_EXTRA'))

await ctx.dispose()
console.log('\nharness ok')
process.exit(0)
