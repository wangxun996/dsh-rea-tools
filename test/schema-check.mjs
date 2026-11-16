/**
 * Schema guard: the provider validates every registered tool's parameters, and
 * one bad tool fails the whole request. Assert the shapes that broke us once:
 * `required` entries and `enum` values must stay primitives, no `$ref`/`$defs`
 * survives, and every property keeps a real schema object.
 *
 * Run: node test/schema-check.mjs
 */
import { readFileSync } from 'node:fs'
import { apply, __internals } from '../lib/index.js'

const catalog = JSON.parse(readFileSync(new URL('./rea-tools.json', import.meta.url), 'utf8'))
const FAKE = JSON.stringify({ type: 'object', properties: {}, additionalProperties: true })

const problems = []
for (const tool of catalog) {
  const schema = __internals.sanitizeSchema(tool.inputSchema)
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        if (path.endsWith('.required') && typeof item !== 'string') {
          problems.push(`${tool.name}: required[${index}] is not a string`)
        }
        if (path.endsWith('.enum') && item !== null && typeof item === 'object') {
          problems.push(`${tool.name}: enum[${index}] is an object`)
        }
        walk(item, `${path}[]`)
      })
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' || key === '$defs' || key === '$schema') problems.push(`${tool.name}: ${path}/${key} survived`)
      walk(value, `${path}.${key}`)
    }
  }
  if (JSON.stringify(schema) === FAKE && Object.keys(tool.inputSchema?.properties ?? {}).length > 0) {
    problems.push(`${tool.name}: schema collapsed to the fallback object`)
  }
  walk(schema, tool.name)
}

// The registered set must pass the same checks.
const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  effect: () => {},
  logger: { info: () => {}, warn: () => {} },
}
await apply(ctx, { toolCallTimeoutMs: 60_000 })
for (const [name, definition] of registered) {
  const text = JSON.stringify(definition.parameters)
  if (text.includes('"$ref"') || text.includes('"$defs"')) problems.push(`${name}: unresolved reference in registered schema`)
  if (text.includes(FAKE.replaceAll('"', '"'))) problems.push(`${name}: fallback object inside registered schema`)
}

console.log(`checked ${catalog.length} upstream schemas, ${registered.size} registered tools`)
if (problems.length === 0) {
  console.log('schema guard: ok')
  process.exit(0)
}
console.log(`schema guard: ${problems.length} problem(s)`)
for (const problem of problems.slice(0, 20)) console.log(` - ${problem}`)
process.exit(1)
