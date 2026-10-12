import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lookup } from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import * as plugin from '../src/index.js'
import { isFakeIp } from '../src/resolver.js'

const limits = { maxResponseBytes: 5000000, maxBodyChars: 100000, timeoutMs: 30000, maxRedirects: 5, userAgent: 'dsh-clash-fake-ip/live-test' }

test('published unpatched backend refuses fake-IP, installed plugin fetches real HTTPS pages', { timeout: 120000 }, async t => {
  const entry = import.meta.resolve('@deepseek-ai/dsh-web-fetch-http')
  assert.equal((await readFile(new URL(entry), 'utf8')).includes('allowClashFakeIp'), false,
    'This test requires the unmodified npm backend, not the earlier source patch')
  t.diagnostic(`Upstream backend: ${entry}`)
  const urls = ['https://example.com/', 'https://api.github.com/repos/deepseek-ai/deepseek-harness',
    'https://github.com/deepseek-ai/deepseek-harness']
  const ctx = new Context()
  try {
    await ctx.plugin(WebRuntime, { fetchProvider: 'http' })
    await ctx.plugin(plugin, {})
    for (const url of urls) {
      const addresses = await lookup(new URL(url).hostname, { all: true })
      assert.ok(addresses.some(entry => isFakeIp(entry.address)), `Expected actual Clash fake-IP DNS for ${url}`)
      await assert.rejects(new HttpFetchProvider(limits).fetch({ url }), { code: 'WEB_BLOCKED_URL' })
      const result = await ctx.web.fetch({ url })
      assert.equal(result.statusCode, 200)
      assert.ok(result.body.content.length > 0)
      if (url.includes('api.github.com')) assert.equal(JSON.parse(result.body.content).full_name, 'deepseek-ai/deepseek-harness')
      if (url.includes('example.com')) assert.match(result.body.content, /Example Domain/)
      t.diagnostic(JSON.stringify({ url, addresses, status: result.statusCode, chars: result.body.content.length }))
    }
    await assert.rejects(ctx.web.fetch({ url: 'http://198.18.0.5/' }), { code: 'WEB_BLOCKED_URL' })
    await assert.rejects(ctx.web.fetch({ url: 'http://169.254.169.254/' }), { code: 'WEB_BLOCKED_URL' })
  } finally { await ctx.fiber.dispose() }
})
