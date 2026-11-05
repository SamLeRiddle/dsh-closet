// dsh-closet 的 Host 半边：只管一件事 —— 把「匣」的配置存在本地，给界面读写。
// 配置放在 <DSH_HOME>/config/dsh-closet.json，只在这台电脑上，不联网。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-closet'
export const inject = ['webServer', 'connection']

const MAX_BODY = 256 * 1024

// 首次启动只有一个空匣；用户在 设置 → 匣 里自己挑哪些入口收进来。
const DEFAULT_CONFIG = {
  version: 1,
  closets: [{ id: 'c1', name: '匣', open: false }],
  entries: {}
}

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

function configPath() {
  return path.join(dshHome(), 'config', 'dsh-closet.json')
}

function routePrefixOf(value) {
  if (value == null || value === '') return '/closet'
  if (typeof value !== 'string') throw new TypeError('routePrefix must be a URL path')
  const raw = value.trim()
  if (!raw || raw.startsWith('//')) throw new TypeError('routePrefix must be a URL path')
  const prefix = '/' + raw.replace(/\/+$/, '').replace(/^\//, '')
  if (prefix === '/') return prefix
  const segments = prefix.slice(1).split('/')
  if (segments.some((segment) => !/^[\w.~-]+$/.test(segment) || segment === '.' || segment === '..')) {
    throw new TypeError('routePrefix must contain non-empty URL path segments without . or ..')
  }
  return prefix
}

function textOf(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit || 60) : ''
}

function sanitizeClosets(input) {
  const out = []
  const seen = new Set()
  const list = Array.isArray(input) ? input : []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const id = textOf(raw.id, 40).replace(/[^\w-]/g, '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: textOf(raw.name, 24) || '匣', open: raw.open === true })
  }
  if (!out.length) out.push({ id: 'c1', name: '匣', open: false })
  return out
}

function sanitizeEntries(input, closetIds) {
  const out = {}
  const list = input && typeof input === 'object' ? input : {}
  for (const key of Object.keys(list)) {
    const raw = list[key]
    if (!raw || typeof raw !== 'object') continue
    const label = textOf(raw.label, 40)
    if (!label) continue
    const panel = textOf(raw.panel, 80) || null
    const closet = closetIds.has(raw.closet) ? raw.closet : null
    const cleanKey = textOf(key, 120) || 'label:' + label
    out[cleanKey] = { label, panel, closet }
  }
  return out
}

function normalize(input) {
  const closets = sanitizeClosets(input && input.closets)
  const ids = new Set(closets.map((item) => item.id))
  const entries = sanitizeEntries(input && input.entries, ids)
  return { version: 1, closets, entries }
}

function writeConfig(cfg) {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function readConfig() {
  const file = configPath()
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return normalize(JSON.parse(raw))
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      try {
        fs.renameSync(file, file + '.broken')
      } catch (renameErr) {}
    }
    const fresh = normalize(DEFAULT_CONFIG)
    try {
      writeConfig(fresh)
    } catch (writeErr) {}
    return fresh
  }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function apply(ctx, config) {
  const prefix = routePrefixOf(config && config.routePrefix)
  const apiPath = (prefix === '/' ? '' : prefix) + '/api/config'
  const isRejected = (req) => {
    try {
      return ctx.connection.requestRejection(req) !== undefined
    } catch (err) {
      return true
    }
  }

  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_CLOSET_CONFIG__', value: { routePrefix: prefix } })
  })

  ctx.effect(() => {
    // 首次启动就把默认配置落盘，方便直接改文件
    try {
      if (!fs.existsSync(configPath())) writeConfig(normalize(DEFAULT_CONFIG))
    } catch (err) {}
  }, 'dsh-closet: seed config')

  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: apiPath,
      handler: async (req, res) => {
        if (isRejected(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const method = (req.method || 'GET').toUpperCase()
        if (method === 'GET' || method === 'HEAD') {
          writeJson(res, 200, { ok: true, config: readConfig(), path: configPath() })
          return
        }
        if (method !== 'POST') {
          res.setHeader('Allow', 'GET, HEAD, POST')
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const raw = await readBody(req)
          const next = normalize(JSON.parse(raw))
          writeConfig(next)
          writeJson(res, 200, { ok: true, config: next })
        } catch (err) {
          writeJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
      }
    })
  }, 'dsh-closet: config route')
}
