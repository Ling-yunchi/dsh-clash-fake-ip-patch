/** DNS validation adapted from DeepSeek Harness's MIT-licensed web-fetch-http resolver. */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'

/** @typedef {{ address: string, family: 4 | 6 }} AllowedAddress */
/** @typedef {(host: string, options: { all: true, order: 'verbatim' }) => Promise<import('node:dns').LookupAddress[]>} Lookup */
/** @typedef {{ bytes: number[], length: number }} Nat64Prefix */
const FAKE_IP_RANGE = ipaddr.parseCIDR('198.18.0.0/15')
const PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96]
const DISCOVERY_HOST = 'ipv4only.arpa'
const SENTINELS = new Set(['192.0.0.170', '192.0.0.171'])

/**
 * Return whether an address is public unicast, including public IPv4-mapped IPv6.
 * @param {string} address - IPv4 or IPv6 text.
 * @returns {boolean}
 */
export function isPublicAddress(address) {
  const parsed = ipaddr.parse(address)
  return parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
    ? parsed.toIPv4Address().range() === 'unicast'
    : parsed.range() === 'unicast'
}

/**
 * Identify the IPv4-only Clash fake-IP range.
 * @param {string} address - Valid IPv4 or IPv6 text.
 * @returns {boolean}
 */
export function isFakeIp(address) {
  const parsed = ipaddr.parse(address)
  return parsed instanceof ipaddr.IPv4 && parsed.match(FAKE_IP_RANGE)
}

/**
 * Resolve once, permit public addresses and hostname-only fake-IP answers, and reject mixed private sets.
 * IPv6 answers undergo RFC 7050 discovery and RFC 6052 destination validation.
 * @param {string} hostname - URL hostname, optionally bracketed IPv6.
 * @param {AbortSignal} signal - Request cancellation.
 * @param {Lookup} resolver - DNS lookup; injectable for isolated tests.
 * @returns {Promise<AllowedAddress[]>} Addresses retained by the upstream pinned transport.
 */
export async function resolveClashAddresses(hostname, signal, resolver = lookup) {
  signal.throwIfAborted()
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const literalFamily = isIP(host)
  const answers = literalFamily === 0
    ? await abortable(resolver(host, { all: true, order: 'verbatim' }), signal)
    : [{ address: host, family: literalFamily }]
  if (answers.length === 0) throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  const prefixes = answers.some(entry => entry.family === 6 && isIP(entry.address) === 6)
    ? await discoverPrefixes(signal, resolver) : []
  /** @type {AllowedAddress[]} */
  const accepted = []
  for (const entry of answers) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    if (!isPublicAddress(entry.address) && !(literalFamily === 0 && isFakeIp(entry.address))) {
      throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
    }
    if (entry.family === 6) {
      const bytes = ipaddr.parse(entry.address).toByteArray()
      for (const prefix of prefixes) {
        if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue
        const destination = embeddedIpv4(bytes, prefix.length)
        if (destination !== undefined && !isPublicAddress(destination)) {
          throw new WebError(`URL hostname "${hostname}" resolves through NAT64 to a non-public IPv4 address`, 'WEB_BLOCKED_URL')
        }
      }
    }
    accepted.push({ address: entry.address, family: entry.family })
  }
  return accepted
}

/**
 * Discover the network's NAT64 prefixes without caching across requests.
 * @param {AbortSignal} signal - Request cancellation.
 * @param {Lookup} resolver - DNS lookup.
 * @returns {Promise<Nat64Prefix[]>}
 */
async function discoverPrefixes(signal, resolver) {
  const answers = await abortable(resolver(DISCOVERY_HOST, { all: true, order: 'verbatim' }), signal)
  /** @type {Nat64Prefix[]} */
  const prefixes = []
  const seen = new Set()
  for (const answer of answers) {
    if (answer.family !== 6 || isIP(answer.address) !== 6) continue
    const bytes = ipaddr.parse(answer.address).toByteArray()
    for (const length of PREFIX_LENGTHS) {
      const embedded = embeddedIpv4(bytes, length)
      if (embedded === undefined || !SENTINELS.has(embedded)) continue
      const prefixBytes = bytes.slice(0, length / 8)
      const key = `${length}:${prefixBytes.join('.')}`
      if (seen.has(key)) continue
      seen.add(key)
      prefixes.push({ bytes: prefixBytes, length })
    }
  }
  return prefixes
}

/**
 * Decode an RFC 6052 IPv4 destination.
 * @param {number[]} bytes - IPv6 address bytes.
 * @param {number} prefixLength - RFC 6052 prefix length.
 * @returns {string | undefined}
 */
function embeddedIpv4(bytes, prefixLength) {
  if (prefixLength === 96) return bytes.slice(12, 16).join('.')
  if (bytes[8] !== 0) return undefined
  const start = prefixLength / 8
  const beforeReserved = 8 - start
  return [...bytes.slice(start, start + beforeReserved), ...bytes.slice(9, 9 + 4 - beforeReserved)].join('.')
}

/**
 * Stop waiting for non-cancellable DNS while consuming its eventual settlement.
 * @template T
 * @param {Promise<T>} promise - Active DNS operation.
 * @param {AbortSignal} signal - Request cancellation.
 * @returns {Promise<T>}
 */
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    if (signal.aborted) abort()
  })
}
