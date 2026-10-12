import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import * as plugin from '../src/index.js'
import { resolveClashAddresses } from '../src/resolver.js'

const limits = { maxResponseBytes: 5000000, maxBodyChars: 100000, timeoutMs: 30000, maxRedirects: 5, userAgent: 'dsh-clash-fake-ip/test' }

test('namespace plugin registers http and removes it on disposal', async () => {
  assert.equal('default' in plugin, false)
  const ctx = new Context()
  try {
    await ctx.plugin(WebRuntime, { fetchProvider: 'http' })
    const fiber = await ctx.plugin(plugin, {})
    await assert.rejects(ctx.web.fetch({ url: 'http://127.0.0.1/' }), { code: 'WEB_BLOCKED_URL' })
    await fiber.dispose()
    await assert.rejects(ctx.web.fetch({ url: 'https://example.com/' }), { code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  } finally { await ctx.fiber.dispose() }
})

test('uses the upstream configuration schema and rejects invalid limits', async () => {
  for (const bad of [{ timeoutMs: 0 }, { timeoutMs: 2147483648 }, { maxResponseBytes: -1 }, { maxRedirects: 1.5 }]) {
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime)
      await assert.rejects(async () => { await ctx.plugin(plugin, bad) })
    } finally { await ctx.fiber.dispose() }
  }
})

test('upstream transport pins the resolver result and preserves HTTP Host through redirects', async t => {
  const observed = []
  const server = createServer((request, response) => {
    observed.push({ host: request.headers.host, path: request.url })
    if (request.url === '/start') response.writeHead(302, { location: '/finish' }).end()
    else response.writeHead(200, { 'content-type': 'text/plain' }).end('pinned response')
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  await listening
  const { port } = server.address()
  const resolutions = []
  const resolver = async (hostname, signal) => {
    const accepted = await resolveClashAddresses(hostname, signal, async () => [{ address: '198.18.0.5', family: 4 }])
    resolutions.push(accepted)
    // The real TUN owns this translation; the fixture maps its accepted answer to its private server.
    return [{ address: '127.0.0.1', family: 4 }]
  }
  const result = await new HttpFetchProvider(limits, resolver).fetch({ url: `http://fixture.invalid:${port}/start` })
  assert.equal(result.body.content, 'pinned response')
  assert.equal(result.statusCode, 200)
  assert.deepEqual(observed, [
    { host: `fixture.invalid:${port}`, path: '/start' }, { host: `fixture.invalid:${port}`, path: '/finish' },
  ])
  assert.deepEqual(resolutions, [[{ address: '198.18.0.5', family: 4 }], [{ address: '198.18.0.5', family: 4 }]])
})
