#!/usr/bin/env node
/**
 * Upload dsh-rea-tools to the DSH plugin market.
 *
 * The market is not an upload API: a plugin is listed when the curated repo
 * `awesome-dsh-plugin/awesome-dsh-plugin` contains `data/plugins/<owner>__<repo>.yml`
 * and the package is installable (npm, or a git URL in the entry). So this
 * script does the three real steps:
 *
 *   1. repo   — create github.com/wangxun996/dsh-rea-tools, add the
 *               `dsh-plugin` topic, commit and push this directory
 *   2. npm    — `npm publish --access public` as dsh-rea-tools
 *   3. pr     — fork awesome-dsh-plugin, add the entry file, open a PR
 *
 * Usage:
 *   GH_TOKEN=ghp_xxx NPM_TOKEN=npm_xxx node upload-to-market.mjs
 *   GH_TOKEN=... NPM_TOKEN=... node upload-to-market.mjs --only=repo
 *   node upload-to-market.mjs --check        # verify inputs, change nothing
 *
 * Tokens: GH_TOKEN needs `repo` scope (classic) or Contents+Pull requests
 * (fine-grained, on your own fork source). NPM_TOKEN is a granular/automation
 * token with publish rights for dsh-rea-tools.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const OWNER = 'wangxun996'
const REPO = 'dsh-rea-tools'
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const ENTRY_FILE = 'data/plugins/wangxun996__dsh-rea-tools.yml'
const ENTRY_PATH = join(ROOT, 'market', 'data__plugins__wangxun996__dsh-rea-tools.yml')
const MARKET_OWNER = 'awesome-dsh-plugin'
const MARKET_REPO = 'awesome-dsh-plugin'
const BRANCH = 'add-dsh-rea-tools'

const args = process.argv.slice(2)
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1]
const check = args.includes('--check')
const GH_TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ''
const NPM_TOKEN = process.env.NPM_TOKEN ?? ''

const api = (path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${GH_TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  })

async function apiJson(path, init) {
  const response = await api(path, init)
  const text = await response.text()
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${response.status} ${text.slice(0, 300)}`)
  return text === '' ? {} : JSON.parse(text)
}

const git = (gitArgs, options = {}) =>
  execFileSync('git', gitArgs, { cwd: ROOT, stdio: 'inherit', ...options })

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function checkInputs(needs = { repo: true, npm: true, pr: true }) {
  const problems = []
  if (PKG.name !== 'dsh-rea-tools') problems.push(`package.json name is ${PKG.name}, expected dsh-rea-tools`)
  if (PKG.private === true) problems.push('package.json still has "private": true — npm publish would fail')
  if (PKG.dsh?.bundle?.patch === undefined) problems.push('package.json must declare dsh.bundle.patch')
  if (!existsSync(join(ROOT, 'cordis.patch.yml'))) problems.push('cordis.patch.yml is missing')
  if (!existsSync(ENTRY_PATH)) problems.push(`${ENTRY_FILE} is missing under market/`)
  if ((needs.repo || needs.pr) && !GH_TOKEN) problems.push('GH_TOKEN is empty')
  if (needs.npm && !NPM_TOKEN) problems.push('NPM_TOKEN is empty')
  return problems
}

async function stageRepo() {
  const url = `https://x-access-token:${GH_TOKEN}@github.com/${OWNER}/${REPO}.git`
  const existing = await api(`/repos/${OWNER}/${REPO}`)
  if (existing.status === 404) {
    console.log(`· creating https://github.com/${OWNER}/${REPO}`)
    await apiJson('/user/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: REPO,
        description: PKG.description,
        homepage: `https://www.npmjs.com/package/${PKG.name}`,
        private: false,
        has_issues: true,
        has_wiki: false,
      }),
    })
  } else if (!existing.ok) {
    throw new Error(`cannot read the repository: ${existing.status}`)
  } else {
    console.log(`· repository already exists`)
  }

  // Fine-grained tokens usually lack the Administration permission topics need;
  // it is optional for listing, so a refusal is a warning, not a failure.
  try {
    await apiJson(`/repos/${OWNER}/${REPO}/topics`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names: ['dsh-plugin', 'deepseek-harness', 'reverse-engineering', 'mcp'] }),
    })
    console.log('· topics set (dsh-plugin)')
  } catch (error) {
    console.log(`! topics not set (${String(error.message).slice(0, 90)}) — add the dsh-plugin topic by hand`)
  }

  if (!existsSync(join(ROOT, '.git'))) git(['init', '-b', 'main'])
  const ignore = join(ROOT, '.gitignore')
  const wanted = ['node_modules/', '*.tgz', '.rea-*', '.dsh-rea*']
  const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
  const missing = wanted.filter((line) => !current.split('\n').includes(line))
  if (missing.length > 0) writeFileSync(ignore, `${current}${current === '' ? '' : '\n'}${missing.join('\n')}\n`)
  git(['add', '-A'])
  try {
    git(['commit', '-m', `feat: ${PKG.name} ${PKG.version} — REA reverse-engineering engine as DSH tools`])
  } catch {
    console.log('· nothing new to commit')
  }
  git(['remote', 'remove', 'origin'], { stdio: 'ignore' })
  git(['remote', 'add', 'origin', url], { stdio: 'ignore' })
  git(['push', '-u', 'origin', 'main'])
  console.log(`· pushed to https://github.com/${OWNER}/${REPO}`)
  console.log('! the market CI wants a repository older than 1 day — submit the PR after that')
}

async function stageNpm() {
  const npmrc = join(ROOT, '.npmrc.publish')
  writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`)
  try {
    execFileSync('npm', ['publish', '--access', 'public', '--userconfig', npmrc], { cwd: ROOT, stdio: 'inherit' })
    console.log(`· published ${PKG.name}@${PKG.version}`)
  } finally {
    rmSync(npmrc, { force: true })
  }
}

async function stagePr() {
  const content = readFileSync(ENTRY_PATH, 'utf8')
  const fork = await api(`/repos/${MARKET_OWNER}/${MARKET_REPO}/forks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ default_branch_only: true }),
  })
  if (!fork.ok && fork.status !== 422) throw new Error(`fork failed: ${fork.status}`)

  let base = ''
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ref = await api(`/repos/${OWNER}/${MARKET_REPO}/git/ref/heads/main`)
    if (ref.ok) {
      base = (await ref.json()).object.sha
      break
    }
    await sleep(3000)
  }
  if (base === '') throw new Error('fork did not become readable; re-run with --only=pr later')

  const created = await api(`/repos/${OWNER}/${MARKET_REPO}/git/refs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: base }),
  })
  if (!created.ok && created.status !== 422) throw new Error(`branch failed: ${created.status}`)

  await apiJson(`/repos/${OWNER}/${MARKET_REPO}/contents/${ENTRY_FILE}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: `Add ${OWNER}/${REPO}`,
      branch: BRANCH,
      content: Buffer.from(content, 'utf8').toString('base64'),
    }),
  })
  console.log(`· added ${ENTRY_FILE} on ${OWNER}:${BRANCH}`)

  const pr = await apiJson(`/repos/${MARKET_OWNER}/${MARKET_REPO}/pulls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: `Add ${OWNER}/${REPO}`,
      head: `${OWNER}:${BRANCH}`,
      base: 'main',
      body: [
        `Adds \`${OWNER}/${REPO}\` under \`tools\`.`,
        '',
        `- npm: \`${PKG.name}@${PKG.version}\` (bundles \`rea-agents@6.9.0\` as an MCP engine over stdio)`,
        `- declares \`dsh.bundle.patch\` in package.json → installable with \`dsh plugin --profile web add ${PKG.name}\``,
        `- registers 16 REA tools plus \`rea_tools\` / \`rea_call\` gateways over the engine's 255-tool catalog`,
        '',
        'The description was checked against the code: `lib/catalog.js` lists 16 direct tools, `lib/index.js` registers those plus the two gateways.',
      ].join('\n'),
    }),
  })
  console.log(`· PR opened: ${pr.html_url}`)
}

const needs = { repo: only === undefined || only === 'repo', npm: only === undefined || only === 'npm', pr: only === undefined || only === 'pr' }
const problems = checkInputs(needs)
if (check || (problems.length > 0 && !check)) {
  console.log(`dsh-rea-tools → market\n`)
  console.log(`package : ${PKG.name}@${PKG.version}`)
  console.log(`repo    : https://github.com/${OWNER}/${REPO}`)
  console.log(`entry   : ${ENTRY_FILE}`)
  if (problems.length === 0) console.log('\nall inputs present — re-run without --check to upload')
  else {
    console.log('\nblocking:')
    for (const problem of problems) console.log(` - ${problem}`)
  }
  if (check) process.exit(problems.length === 0 ? 0 : 1)
  process.exit(1)
}

if (only === undefined || only === 'repo') await stageRepo()
if (only === undefined || only === 'npm') await stageNpm()
if (only === undefined || only === 'pr') await stagePr()
