import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import * as plugin from '../src/index.js'

test('keeps explicit proxy routing and blocks non-public address literals', async t => {
  const seen = []
  const proxy = createServer((request, response) => {
    seen.push(request.url)
    response.writeHead(200, { 'content-type': 'text/plain' }).end('via proxy')
  })
  const listening = once(proxy, 'listening')
  proxy.listen(0, '127.0.0.1')
  t.after(async () => { proxy.closeAllConnections(); await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())) })
  await listening
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  const disposeProxy = await installProxyFromEnvironment({ get: key => ['HTTP_PROXY', 'HTTPS_PROXY'].includes(key) ? { value: proxyUrl } : undefined }, () => {})
  const ctx = new Context()
  try {
    await ctx.plugin(WebRuntime)
    await ctx.plugin(plugin, {})
    const result = await ctx.web.fetch({ url: 'http://proxy-only.invalid/page' })
    assert.equal(result.body.content, 'via proxy')
    assert.deepEqual(seen, ['http://proxy-only.invalid/page'])
    await assert.rejects(ctx.web.fetch({ url: 'http://198.18.0.5/' }), { code: 'WEB_BLOCKED_URL' })
    await assert.rejects(ctx.web.fetch({ url: 'http://169.254.169.254/' }), { code: 'WEB_BLOCKED_URL' })
    assert.equal(seen.length, 1)
  } finally {
    await ctx.fiber.dispose()
    await disposeProxy()
  }
})
