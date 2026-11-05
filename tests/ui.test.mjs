import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/ui.js', import.meta.url), 'utf8')
const settle = () => new Promise(resolve => setImmediate(resolve))

function elements(tree) {
  if (tree == null) return []
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (typeof tree !== 'object') return [tree]
  return [tree, ...elements(tree.children)]
}

function textOf(tree) {
  return elements(tree).filter(value => typeof value === 'string').join('\n')
}

function startUI({ baseURI = 'http://dsh.test/', clientConfig, rows = [] } = {}) {
  const requests = []
  const registrations = []
  const attrs = {}
  const listeners = {}
  let disposers = []
  let plugin
  let currentHooks = null
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(value) {
      if (!currentHooks) return [value, () => {}]
      const hooks = currentHooks
      const index = hooks.cursor++
      if (!(index in hooks.values)) hooks.values[index] = value
      return [hooks.values[index], next => { hooks.values[index] = next }]
    },
    useRef(value) {
      if (!currentHooks) return { current: value }
      const index = currentHooks.cursor++
      if (!(index in currentHooks.values)) currentHooks.values[index] = { current: value }
      return currentHooks.values[index]
    },
    useEffect() {},
  }
  const sidebarRow = label => ({
    getAttribute(name) { return name === 'aria-label' ? label : null },
    querySelector() { return null },
    click() {},
  })
  const document = {
    baseURI,
    documentElement: { setAttribute(name, value) { attrs[name] = value } },
    head: { appendChild() {} },
    createElement() { return { setAttribute() {}, remove() {}, textContent: '' } },
    querySelectorAll(selector) {
      if (selector !== 'button[class*="panelRow"]') return []
      return rows.map(sidebarRow)
    },
    addEventListener(name, listener) { listeners[name] = listener },
    removeEventListener(name, listener) {
      if (listeners[name] === listener) delete listeners[name]
    },
  }
  vm.runInNewContext(source, {
    URL,
    document,
    window: {
      __DSH_CLOSET_CONFIG__: clientConfig,
      __ModuleLoader__: { load({ factory }) { plugin = factory(() => React) } },
    },
    fetch(url, options = {}) {
      return new Promise((resolve, reject) => requests.push({
        url,
        options,
        settled: false,
        body() { return JSON.parse(options.body) },
        respond(json, status = 200) {
          this.settled = true
          resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(json) })
        },
        fail(error = new Error('network disconnected')) {
          this.settled = true
          reject(error)
        },
      }))
    },
  })
  const context = {
    effect(effect) {
      const dispose = effect()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    slots: {
      inject(name, effect) {
        const dispose = effect()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
      register(meta, component) {
        const registration = { meta, component }
        registrations.push(registration)
        return () => {
          const index = registrations.indexOf(registration)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
  }
  plugin.apply(context)
  const settings = () => registrations.find(row => row.meta.name === 'settings.section').component()
  const clickButton = name => {
    const button = elements(settings()).find(element => element?.type === 'button' &&
      (typeof name === 'string' ? textOf(element) === name : name.test(textOf(element))))
    assert.ok(button, `Expected settings button ${name}`)
    assert.notEqual(button.props.disabled, true, 'Expected the button to be enabled')
    button.props.onClick()
  }
  return {
    requests,
    attrs,
    settings,
    headCount: () => registrations.filter(row => row.meta.name === 'sidebar.panellist' && row.meta.id.startsWith('closet-head-')).length,
    childCount: () => registrations.filter(row => row.meta.name === 'sidebar.panellist' && row.meta.id.startsWith('closet-item-')).length,
    dispose() {
      const current = disposers
      disposers = []
      for (const dispose of current.reverse()) dispose()
    },
    reapply: () => plugin.apply(context),
    posts: () => requests.filter(request => request.options.method === 'POST'),
    clickButton,
    addCloset: () => clickButton('＋ 新建一个匣'),
    nameField(index = 0) {
      const node = elements(settings()).filter(element =>
        typeof element?.type === 'function' && typeof element.props.onCommit === 'function')[index]
      assert.ok(node, 'Expected a registered name editor')
      const hooks = { cursor: 0, values: [] }
      return {
        render() {
          currentHooks = hooks
          hooks.cursor = 0
          try { return node.type(node.props) }
          finally { currentHooks = null }
        },
      }
    },
    toggle(id = 'c1') {
      const button = {
        querySelector(selector) {
          return selector === '[data-closet-head]' ? { getAttribute() { return id } } : null
        },
      }
      listeners.click({
        target: { closest() { return button } },
        preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
      })
    },
  }
}

const initial = () => ({
  version: 1,
  closets: [{ id: 'c1', name: '匣', open: false }],
  entries: {},
})

async function loadedUI(options) {
  const ui = startUI(options)
  ui.requests[0].respond({ ok: true, config: initial(), path: '/test/config/dsh-closet.json' })
  await settle()
  return ui
}

test('serializes saves and coalesces queued edits without applying an older response', async () => {
  const ui = await loadedUI()
  ui.toggle()
  ui.toggle()
  ui.addCloset()
  ui.addCloset()
  assert.equal(ui.posts().length, 1, 'Only the first save can be in flight')
  assert.equal(ui.attrs['data-closet-c1'], 'closed', 'The latest toggle takes effect immediately')
  const first = ui.posts()[0]
  assert.equal(first.body().closets[0].open, true)
  assert.match(textOf(ui.settings()), /保存中/)
  first.respond({ ok: true, config: first.body() })
  await settle()
  assert.equal(ui.attrs['data-closet-c1'], 'closed', 'An earlier response must not revert the current UI')
  assert.equal(ui.posts().length, 2, 'Queued snapshots are merged into one latest save')
  const latest = ui.posts()[1]
  assert.equal(latest.body().closets.length, 3)
  assert.equal(latest.body().closets[0].open, false)
  assert.equal(ui.posts().filter(request => !request.settled).length, 1)
  latest.respond({ ok: true, config: latest.body() })
  await settle()
  assert.equal(ui.posts().length, 2)
  assert.equal(ui.attrs['data-closet-c1'], 'closed')
  assert.doesNotMatch(textOf(ui.settings()), /保存失败/)
  assert.match(textOf(ui.settings()), /已保存/)
})

test('shows a failed save with existing configuration and retries the latest edits', async () => {
  const ui = await loadedUI()
  ui.addCloset()
  ui.toggle()
  const first = ui.posts()[0]
  first.respond({ ok: false, error: 'EACCES: permission denied' }, 400)
  await settle()
  assert.match(textOf(ui.settings()), /保存失败/)
  assert.ok(elements(ui.settings()).some(element => element?.props?.role === 'alert'))
  assert.equal(ui.posts().length, 1, 'A failure waits for an explicit retry')
  assert.equal(ui.attrs['data-closet-c1'], 'open', 'Failed saving retains the latest user edits')
  ui.clickButton('重试保存')
  assert.equal(ui.posts().length, 2)
  const retry = ui.posts()[1]
  assert.equal(retry.body().closets.length, 2)
  assert.equal(retry.body().closets[0].open, true)
  retry.respond({ ok: true, config: retry.body() })
  await settle()
  assert.doesNotMatch(textOf(ui.settings()), /保存失败/)
  assert.match(textOf(ui.settings()), /已保存/)
})

test('shows network failures and allows saving again', async () => {
  const ui = await loadedUI()
  ui.addCloset()
  ui.posts()[0].fail()
  await settle()
  assert.match(textOf(ui.settings()), /保存失败/)
  ui.clickButton('重试保存')
  const retry = ui.posts()[1]
  assert.equal(retry.body().closets.length, 2)
  retry.respond({ ok: true, config: retry.body() })
  await settle()
  assert.doesNotMatch(textOf(ui.settings()), /保存失败/)
})

test('does not start queued work or restore rows after the plugin is disposed', async () => {
  const ui = await loadedUI()
  ui.toggle()
  ui.addCloset()
  const first = ui.posts()[0]
  ui.dispose()
  assert.equal(ui.headCount(), 0)
  first.respond({ ok: true, config: first.body() })
  await settle()
  assert.equal(ui.posts().length, 1, 'Disposal cancels the waiting snapshot')
  assert.equal(ui.headCount(), 0, 'A late response must not register sidebar rows again')
})

test('ignores a previous plugin instance response after a fresh instance has loaded', async () => {
  const ui = await loadedUI()
  ui.toggle()
  const oldSave = ui.posts()[0]
  ui.dispose()
  ui.reapply()
  const freshRead = ui.requests.filter(request => request.options.method !== 'POST').at(-1)
  const freshConfig = initial()
  freshConfig.closets.push({ id: 'c2', name: '新实例', open: false })
  freshRead.respond({ ok: true, config: freshConfig })
  await settle()
  assert.equal(ui.headCount(), 2)
  oldSave.respond({ ok: true, config: oldSave.body() })
  await settle()
  assert.equal(ui.attrs['data-closet-c1'], 'closed')
  assert.equal(ui.headCount(), 2, 'The old save must not replace the new instance configuration')
})

test('does not draw closet rows for panels that are gone from the sidebar', async () => {
  const ui = startUI({ rows: ['插件', '便签', '统计'] })
  ui.requests[0].respond({
    ok: true,
    config: { version: 1, closets: [{ id: 'c1', name: '匣', open: true }], entries: { 便签: 'c1', 已停用: 'c1' } },
    path: '/test/config/dsh-closet.json',
  })
  await settle()
  assert.equal(ui.childCount(), 1, 'Only the entry whose sidebar row still exists gets a row')
  assert.match(textOf(ui.settings()), /侧栏里没找到/)
})

test('keeps every configured member while the sidebar has not rendered yet', async () => {
  const ui = startUI()
  ui.requests[0].respond({
    ok: true,
    config: { version: 1, closets: [{ id: 'c1', name: '匣', open: true }], entries: { 便签: 'c1', 统计: 'c1' } },
    path: '/test/config/dsh-closet.json',
  })
  await settle()
  assert.equal(ui.childCount(), 2, 'An empty sidebar is not evidence that the plugins disappeared')
})

test('Escape cancels an edited name before blur can save it, and later edits still save', async () => {
  const ui = await loadedUI()
  const field = ui.nameField()
  let input = field.render()
  input.props.onChange({ target: { value: '不应保存' } })
  input = field.render()
  assert.equal(input.props.value, '不应保存')
  let prevented = false
  let stopped = false
  let blurred = false
  input.props.onKeyDown({
    key: 'Escape',
    preventDefault() { prevented = true },
    stopPropagation() { stopped = true },
    currentTarget: { blur() { blurred = true; input.props.onBlur() } },
  })
  assert.equal(prevented, true)
  assert.equal(stopped, true)
  assert.equal(blurred, true)
  assert.equal(ui.posts().length, 0, 'Escape must not enqueue a save from the stale blur handler')
  input = field.render()
  assert.equal(input.props.value, '匣')
  input.props.onChange({ target: { value: '正常保存' } })
  input = field.render()
  input.props.onBlur()
  assert.equal(ui.posts().length, 1)
  const request = ui.posts()[0]
  assert.equal(request.body().closets[0].name, '正常保存')
  request.respond({ ok: true, config: request.body() })
  await settle()
  assert.match(textOf(ui.settings()), /已保存/)
})

for (const { name, baseURI, clientConfig, expected } of [
  { name: 'default prefix', baseURI: 'http://dsh.test/', expected: 'http://dsh.test/closet/api/config' },
  { name: 'custom Host prefix', baseURI: 'http://dsh.test/', clientConfig: { routePrefix: '/custom' }, expected: 'http://dsh.test/custom/api/config' },
  { name: 'custom prefix under an application mount', baseURI: 'http://dsh.test/harness/', clientConfig: { routePrefix: '/custom' }, expected: 'http://dsh.test/harness/custom/api/config' },
]) {
  test(`uses ${name} for both configuration reads and writes`, async () => {
    const ui = await loadedUI({ baseURI, clientConfig })
    assert.equal(ui.requests[0].url, expected)
    ui.addCloset()
    assert.equal(ui.posts()[0].url, expected)
    ui.posts()[0].respond({ ok: true, config: ui.posts()[0].body() })
    await settle()
    assert.doesNotMatch(textOf(ui.settings()), /保存失败/)
  })
}
