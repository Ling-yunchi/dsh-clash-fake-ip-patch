import { test } from 'node:test'
import assert from 'node:assert/strict'
import ipaddr from 'ipaddr.js'
import { isFakeIp, resolveClashAddresses } from '../src/resolver.js'

const signal = () => new AbortController().signal
const answers = (...addresses) => async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
const blocked = { code: 'WEB_BLOCKED_URL' }

test('fake-IP range includes both edges and excludes adjacent addresses and mapped IPv6', () => {
  for (const address of ['198.18.0.0', '198.19.255.255']) assert.equal(isFakeIp(address), true)
  for (const address of ['198.17.255.255', '198.20.0.0', '::ffff:198.18.0.1']) assert.equal(isFakeIp(address), false)
})

test('retains real public and fake-IP DNS answers without changing addresses', async () => {
  assert.deepEqual(await resolveClashAddresses('github.test', signal(), answers('198.18.0.5', '8.8.8.8')), [
    { address: '198.18.0.5', family: 4 }, { address: '8.8.8.8', family: 4 },
  ])
})

for (const address of ['0.0.0.0', '10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254',
  '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
  test(`rejects DNS sets containing ${address} alongside fake-IP`, async () => {
    await assert.rejects(resolveClashAddresses('mixed.test', signal(), answers('198.18.0.5', address)), blocked)
  })
}

for (const host of ['198.18.0.5', '127.0.0.1', '10.0.0.1', '[::ffff:198.18.0.5]', '[::1]']) {
  test(`rejects the literal ${host}`, async () => {
    await assert.rejects(resolveClashAddresses(host, signal(), answers()), blocked)
  })
}

test('keeps public literals available and bracketed IPv6 intact', async () => {
  assert.deepEqual(await resolveClashAddresses('8.8.8.8', signal(), answers()), [{ address: '8.8.8.8', family: 4 }])
  assert.deepEqual(await resolveClashAddresses('[2001:4860:4860::8888]', signal(), answers()), [
    { address: '2001:4860:4860::8888', family: 6 },
  ])
})

test('rejects empty and malformed DNS results', async () => {
  for (const entries of [[], [{ address: 'bad', family: 4 }], [{ address: '8.8.8.8', family: 6 }]]) {
    await assert.rejects(resolveClashAddresses('invalid.test', signal(), async () => entries), { code: 'WEB_PROVIDER_ERROR' })
  }
})

function translate(length, address) {
  const bytes = new Array(16).fill(0)
  const prefix = [0x20, 0x01, 0x48, 0x60, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 0]
  for (let i = 0; i < length / 8; i++) bytes[i] = prefix[i]
  const ipv4 = address.split('.').map(Number)
  if (length === 96) bytes.splice(12, 4, ...ipv4)
  else {
    const before = 8 - length / 8
    for (let i = 0; i < 4; i++) bytes[i < before ? length / 8 + i : 9 + i - before] = ipv4[i]
  }
  return ipaddr.fromByteArray(bytes).toString()
}

for (const length of [32, 40, 48, 56, 64, 96]) {
  test(`NAT64 /${length} refuses private and fake-IP destinations and permits public IPv4`, async () => {
    for (const [address, allowed] of [['127.0.0.1', false], ['198.18.0.5', false], ['8.8.8.8', true]]) {
      const translated = translate(length, address)
      const resolver = async host => host === 'ipv4only.arpa'
        ? [{ address: translate(length, '192.0.0.170'), family: 6 }, { address: translate(length, '192.0.0.171'), family: 6 }]
        : [{ address: translated, family: 6 }]
      const result = resolveClashAddresses('nat64.test', signal(), resolver)
      if (allowed) assert.deepEqual(await result, [{ address: translated, family: 6 }])
      else await assert.rejects(result, blocked)
    }
  })
}

test('cancellation stops waiting for DNS and consumes its later rejection', async () => {
  const controller = new AbortController()
  const deferred = Promise.withResolvers()
  const pending = resolveClashAddresses('slow.test', controller.signal, () => deferred.promise)
  controller.abort(new Error('stop'))
  await assert.rejects(pending, /stop/)
  deferred.reject(new Error('late DNS failure'))
  let called = false
  await assert.rejects(resolveClashAddresses('slow.test', controller.signal, async () => { called = true; return [] }), /stop/)
  assert.equal(called, false)
})

test('DNS failures propagate without accepting an unvalidated address', async () => {
  await assert.rejects(resolveClashAddresses('broken.test', signal(), async () => { throw new Error('DNS unavailable') }), /DNS unavailable/)
})
