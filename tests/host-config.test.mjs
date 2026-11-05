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
