import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'

function host(t, config) {
  const previousHome = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-closet-host-test-'))
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  const events = new EventEmitter()
  const routes = []
  const ctx = {
    on(name, listener) { events.on(name, listener); return () => events.off(name, listener) },
    effect(factory) { return factory() },
    connection: { requestRejection() { return undefined } },
    webServer: {
      register(route) {
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      },
    },
  }
  apply(ctx, config)
  return {
    home, routes,
    injections() {
      const rows = []
      events.emit('webserver/index-inject', rows)
      return rows
    },
    async request(method, body) {
      const req = new EventEmitter()
      req.method = method
      const res = {
        headers: {},
        setHeader(name, value) { this.headers[name] = value },
        end(value) { this.body = JSON.parse(value) },
      }
      const pending = routes[0].handler(req, res)
      if (body !== undefined) {
        req.emit('data', Buffer.from(JSON.stringify(body)))
        req.emit('end')
      }
      await pending
      return res
    },
  }
}

test('default route is published to the browser and serves the existing config format', async t => {
  const app = host(t)
  assert.equal(app.routes[0].path, '/closet/api/config')
  assert.deepEqual(app.injections(), [{
    kind: 'global', name: '__DSH_CLOSET_CONFIG__', value: { routePrefix: '/closet' },
  }])
  const response = await app.request('GET')
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.config.version, 1)
  assert.equal(response.body.config.closets[0].id, 'c1')
})

test('custom relative prefix and trailing slashes select the same browser and Host endpoint', async t => {
  const app = host(t, { routePrefix: 'tools.v2/closet///' })
  assert.equal(app.routes[0].path, '/tools.v2/closet/api/config')
  assert.equal(app.injections()[0].value.routePrefix, '/tools.v2/closet')
  const next = { version: 1, closets: [{ id: 'work', name: '工作', open: true }], entries: {} }
  assert.equal((await app.request('POST', next)).statusCode, 200)
  assert.deepEqual((await app.request('GET')).body.config, next)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app.home, 'config/dsh-closet.json'), 'utf8')), next)
})

test('root prefix registers one leading slash and is published without being replaced by the default', t => {
  const app = host(t, { routePrefix: '/' })
  assert.equal(app.routes[0].path, '/api/config')
  assert.equal(app.injections()[0].value.routePrefix, '/')
})

test('invalid prefixes fail before registering routes or bootstrap data', () => {
  for (const prefix of [false, 3, {}, ' ', '//external.test', 'https://external.test', '/a?b', '/a#b', '/a\\b', '/a//b', '/a/../b', '/./a', '/a%2fb']) {
    let registrations = 0
    const ctx = {
      on() { registrations++ },
      effect() { registrations++ },
      connection: {},
      webServer: {},
    }
    assert.throws(() => apply(ctx, { routePrefix: prefix }), /routePrefix/)
    assert.equal(registrations, 0)
  }
})

for (const code of ['EACCES', 'EBUSY']) {
  test(`a temporary ${code} read failure preserves the file and reports a retryable error`, async t => {
    const app = host(t)
    const file = path.join(app.home, 'config/dsh-closet.json')
    const saved = { version: 1, closets: [{ id: 'work', name: '工作', open: true }], entries: {} }
    const raw = JSON.stringify(saved)
    fs.writeFileSync(file, raw)
    const read = fs.readFileSync
    let failed
    fs.readFileSync = function (target, ...args) {
      if (target === file) throw Object.assign(new Error('temporary read failure'), { code })
      return read.call(this, target, ...args)
    }
    try { failed = await app.request('GET') }
    finally { fs.readFileSync = read }
    assert.equal(failed.statusCode, 503)
    assert.equal(failed.body.ok, false)
    assert.equal(failed.body.code, code)
    assert.equal(Object.hasOwn(failed.body, 'config'), false)
    assert.equal(fs.readFileSync(file, 'utf8'), raw)
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['dsh-closet.json'])
    assert.deepEqual((await app.request('GET')).body.config, saved)
  })
}

test('only a missing configuration is created with defaults', async t => {
  const app = host(t)
  const file = path.join(app.home, 'config/dsh-closet.json')
  fs.unlinkSync(file)
  const response = await app.request('GET')
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.config.closets[0].id, 'c1')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), response.body.config)
})

test('invalid JSON is preserved before rebuilding and existing broken backups are retained', async t => {
  const app = host(t)
  const file = path.join(app.home, 'config/dsh-closet.json')
  fs.writeFileSync(file + '.broken', 'an earlier damaged file')
  fs.writeFileSync(file, '{invalid json')
  const response = await app.request('GET')
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.config.version, 1)
  assert.equal(fs.readFileSync(file + '.broken', 'utf8'), 'an earlier damaged file')
  assert.equal(fs.readFileSync(file + '.broken.1', 'utf8'), '{invalid json')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), response.body.config)
})

test('a failed corruption backup keeps the original file and does not create a default configuration', async t => {
  const app = host(t)
  const file = path.join(app.home, 'config/dsh-closet.json')
  const raw = '{invalid json'
  fs.writeFileSync(file, raw)
  const rename = fs.renameSync
  let response
  fs.renameSync = function (from, to) {
    if (from === file) throw Object.assign(new Error('file busy'), { code: 'EBUSY' })
    return rename.call(this, from, to)
  }
  try { response = await app.request('GET') }
  finally { fs.renameSync = rename }
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.ok, false)
  assert.equal(fs.readFileSync(file, 'utf8'), raw)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['dsh-closet.json'])
})
