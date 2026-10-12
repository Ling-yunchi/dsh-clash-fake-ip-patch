/** Clash fake-IP resolver plugin over the upstream, unmodified HTTP fetch provider. */
import { Config as HttpConfig, HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { resolveClashAddresses } from './resolver.js'

export const name = 'web-fetch-http-clash'
export const inject = ['web']
/** Uses the upstream timeout, redirect, response-size and User-Agent configuration. */
export const Config = HttpConfig

/**
 * Register the `http` provider with Clash-aware DNS validation.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Context providing the web service.
 * @param {import('@deepseek-ai/dsh-web-fetch-http').HttpFetchLimits} config - Schema-resolved limits.
 * @returns {void}
 */
export function apply(ctx, config) {
  for (const key of ['maxResponseBytes', 'maxBodyChars', 'timeoutMs']) {
    const value = config[/** @type {'maxResponseBytes' | 'maxBodyChars' | 'timeoutMs'} */ (key)]
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}: ${key} must be positive and finite`)
  }
  if (config.timeoutMs > 2_147_483_647) throw new Error(`${name}: timeoutMs exceeds the Node timer range`)
  if (!Number.isInteger(config.maxRedirects) || config.maxRedirects < 0) {
    throw new Error(`${name}: maxRedirects must be a non-negative integer`)
  }
  ctx.web.registerFetchProvider(new HttpFetchProvider(config, (hostname, signal) => resolveClashAddresses(hostname, signal)))
}
