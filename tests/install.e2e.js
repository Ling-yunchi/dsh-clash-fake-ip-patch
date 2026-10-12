import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
const cli = process.env.DSH_TEST_CLI

test('dsh plugin add/remove persists the bundle and restores the stock fetch provider', { timeout: 240000, skip: !cli && 'Set DSH_TEST_CLI to a built dsh CLI entry' }, async t => {
  const outputRoot = join(project, '.test-output')
  await mkdir(outputRoot, { recursive: true })
  const root = await mkdtemp(join(outputRoot, 'install-'))
  const live = new Map()
  async function terminate(child) {
    if (child.pid === undefined || !live.has(child)) return
    const closed = live.get(child)
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
        killer.once('error', reject)
        killer.once('close', resolve)
      })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    await closed
  }
  t.after(async () => {
    await Promise.all([...live.keys()].map(terminate))
    assert.equal(dirname(root), outputRoot)
    await rm(root, { recursive: true, force: true })
  })
  const profile = join(root, 'home', 'profiles', 'clash-smoke')
  const fixture = join(root, 'fixture-base')
  const cwd = join(root, 'workspace')
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(fixture), mkdir(cwd)])
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-clash-smoke', private: true,
    dependencies: {}, dsh: { profile: { bundles: [] } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'clash-fixture-base', version: '1.0.0', type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  const stockEntry = import.meta.resolve('@deepseek-ai/dsh-web-fetch-http')
  assert.equal((await readFile(new URL(stockEntry), 'utf8')).includes('allowClashFakeIp'), false)
  const webEntry = import.meta.resolve('@deepseek-ai/dsh-web')
  await writeFile(join(fixture, 'cordis.patch.yml'), `- insert:\n    - id: web\n      name: ${JSON.stringify(webEntry)}\n      config:\n        fetchProvider: http\n    - id: web-fetch-http\n      name: ${JSON.stringify(stockEntry)}\n    - id: clash-smoke-driver\n      name: ./driver.js\n`)
  await writeFile(join(fixture, 'driver.js'), `export const inject = ['web']\nexport function apply(ctx) {\n  const ready = ctx.get('appReady')\n  const exit = ctx.get('appExit')\n  if (!ready || !exit) throw new Error('Missing profile lifecycle services')\n  ctx.effect(() => ready.onReady(() => {\n    void (async () => {\n      try {\n        const result = await ctx.web.fetch({ url: 'https://example.com/' })\n        process.stdout.write('CLASH_RESULT ' + JSON.stringify({ status: result.statusCode, example: result.body.content.includes('Example Domain') }) + '\\n')\n      } catch (error) {\n        process.stdout.write('CLASH_RESULT ' + JSON.stringify({ code: error.code, message: error.message }) + '\\n')\n      }\n      exit(0)\n    })().catch(error => { process.stderr.write(String(error)); exit(1) })\n  }), 'clash smoke driver')\n}\n`)
  const env = { ...process.env, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1' }
  for (const key of Object.keys(env)) {
    if (/proxy|^NODE_USE_ENV_PROXY$|^TSX_TSCONFIG_PATH$|KEY|SECRET|TOKEN|PASSWORD/i.test(key)) delete env[key]
  }
  let invocation = 0
  async function run(args) {
    const label = String(++invocation)
    const stdoutPath = join(root, `${label}.stdout`)
    const stderrPath = join(root, `${label}.stderr`)
    const stdoutFd = openSync(stdoutPath, 'w')
    const stderrFd = openSync(stderrPath, 'w')
    let child
    try { child = spawn(process.execPath, [resolve(cli), ...args], { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', stdoutFd, stderrFd] }) }
    finally { closeSync(stdoutFd); closeSync(stderrFd) }
    const closed = new Promise(resolve => child.once('close', resolve))
    live.set(child, closed)
    void closed.then(() => live.delete(child))
    let timedOut = false
    let termination
    const timer = setTimeout(() => { timedOut = true; termination = terminate(child).then(() => undefined, error => error) }, 90000)
    let outcome
    try {
      outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
    } finally {
      clearTimeout(timer)
      const terminationError = await termination
      if (terminationError !== undefined) throw terminationError
    }
    const stdout = await readFile(stdoutPath, 'utf8')
    const stderr = await readFile(stderrPath, 'utf8')
    assert.equal(timedOut, false, `CLI deadline: ${args.join(' ')}\n${stderr}`)
    assert.equal(outcome.signal, null, `CLI was signalled: ${stderr}`)
    assert.equal(outcome.code, 0, `CLI failed: ${args.join(' ')}\n${stdout}\n${stderr}`)
    return stdout
  }
  const readManifest = async () => JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  const observe = async () => {
    const stdout = await run(['--profile', 'clash-smoke'])
    const line = stdout.split(/\r?\n/).find(line => line.startsWith('CLASH_RESULT '))
    assert.ok(line, stdout)
    return JSON.parse(line.slice('CLASH_RESULT '.length))
  }
  await run(['plugin', '--profile', 'clash-smoke', 'add', fixture, '--ignore-scripts'])
  assert.equal((await observe()).code, 'WEB_BLOCKED_URL')
  await run(['plugin', '--profile', 'clash-smoke', 'add', process.env.DSH_TEST_SPEC ?? project, '--ignore-scripts'])
  assert.ok((await readManifest()).dsh.profile.bundles.includes('dsh-clash-fake-ip'))
  const installed = await run(['--profile', 'clash-smoke', '--dump-config'])
  assert.match(installed, /id: web-fetch-http-clash/)
  assert.match(installed, /id: web-fetch-http[\s\S]*?disabled: true/)
  assert.deepEqual(await observe(), { status: 200, example: true })
  await run(['plugin', '--profile', 'clash-smoke', 'remove', 'dsh-clash-fake-ip'])
  assert.equal((await readManifest()).dsh.profile.bundles.includes('dsh-clash-fake-ip'), false)
  assert.doesNotMatch(await run(['--profile', 'clash-smoke', '--dump-config']), /id: web-fetch-http-clash/)
  assert.equal((await observe()).code, 'WEB_BLOCKED_URL')
  t.diagnostic(`CLI: ${cli}; unpatched fetch artifact: ${stockEntry}`)
})
