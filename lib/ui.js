// Host 侧导入这个文件时没有 window，直接跳过（真正的界面代码只在浏览器里跑）。
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: 'dsh-closet',
    factory: function (require) {
      var React = require('react')
      var h = React.createElement

      var bootConfig = window.__DSH_CLOSET_CONFIG__ || {}
      var routePrefix = typeof bootConfig.routePrefix === 'string' ? bootConfig.routePrefix : '/closet'
      var relativePrefix = routePrefix.replace(/^\/+|\/+$/g, '')
      var API_CONFIG = (relativePrefix ? relativePrefix + '/' : '') + 'api/config'
      // 宿主自己的行，不参与搬运
      var SYSTEM_LABELS = ['插件', '自动化任务', '更多']
      var ROW_SELECTOR = 'button[class*="panelRow"]'

      var C = {
        text: 'var(--dsw-alias-label-primary)',
        text2: 'var(--dsw-alias-label-secondary)',
        text3: 'var(--dsw-alias-label-tertiary)',
        line: 'var(--dsw-alias-hairline)',
        line2: 'var(--dsw-alias-border-l2)',
        bg1: 'var(--dsw-alias-bg-layer-1)',
        bg2: 'var(--dsw-alias-bg-layer-2)',
        bgHover: 'var(--dsw-alias-interactive-bg-hover)',
        accent: 'var(--dsw-alias-accent)',
        danger: 'var(--dsw-alias-danger)'
      }

      var store = { loading: true, config: null, filePath: '', error: '', notice: '', saving: false, dirty: false, activeLabel: '' }
      var watchers = []
      var appCtx = null
      var rowHandles = []
      var styleEl = null
      var lastSignature = ''
      var pendingSave = null
      var saveInFlight = false
      var lifecycle = 0

      // ---------------------------------------------------------------- store

      function notify() {
        for (var i = 0; i < watchers.length; i++) {
          try {
            watchers[i]()
          } catch (err) {}
        }
      }

      function patch(next) {
        var changed = false
        var key
        for (key in next) {
          if (Object.prototype.hasOwnProperty.call(next, key) && store[key] !== next[key]) {
            store[key] = next[key]
            changed = true
          }
        }
        if (changed) notify()
      }

      function useStore() {
        var pair = React.useState(0)
        var bump = pair[1]
        React.useEffect(function () {
          var fn = function () {
            bump(function (n) { return n + 1 })
          }
          watchers.push(fn)
          return function () {
            var at = watchers.indexOf(fn)
            if (at >= 0) watchers.splice(at, 1)
          }
        }, [])
        return store
      }

      // ---------------------------------------------------------------- config

      function apiUrl() {
        return new URL(API_CONFIG, document.baseURI).href
      }

      function configResponse(res) {
        return res.json().then(function (json) {
          if (!res.ok || !json || json.ok !== true || !json.config) throw new Error('configuration request failed')
          return json
        })
      }

      function normalize(cfg) {
        var closets = []
        var list = (cfg && cfg.closets) || []
        for (var i = 0; i < list.length; i++) {
          var item = list[i]
          if (!item || !item.id) continue
          closets.push({ id: String(item.id), name: String(item.name || '匣'), open: item.open === true })
        }
        if (!closets.length) closets.push({ id: 'c1', name: '匣', open: false })
        // 内部用「名字 → 匣 id」这张简表，界面上只认名字；
        // 存到文件里的是 { label, panel, closet } 这种结构，序列化时再转。
        var entries = {}
        var src = (cfg && cfg.entries) || {}
        for (var key in src) {
          if (!Object.prototype.hasOwnProperty.call(src, key)) continue
          var raw = src[key]
          if (typeof raw === 'string') {
            entries[key] = raw || null
            continue
          }
          if (!raw || typeof raw !== 'object') continue
          var label = String(raw.label || key).replace(/^label:/, '')
          if (!label) continue
          entries[label] = raw.closet || null
        }
        return { version: 1, closets: closets, entries: entries }
      }

      // 界面用的简表 → 存盘用的结构（key 稳定，改名只改 label）
      function serialize(cfg) {
        var closets = closetsOf(cfg)
        var entries = {}
        var map = (cfg && cfg.entries) || {}
        for (var label in map) {
          if (!Object.prototype.hasOwnProperty.call(map, label)) continue
          var owner = map[label] || null
          var id = 'label:' + label
          var closetId = null
          for (var i = 0; i < closets.length; i++) {
            if (closets[i].id === owner) closetId = owner
          }
          entries[id] = { label: label, panel: null, closet: closetId }
        }
        return { version: 1, closets: closets, entries: entries }
      }

      function adopt(cfg, filePath) {
        if (filePath) store.filePath = filePath
        patch({ config: normalize(cfg), loading: false, error: '', dirty: false })
        refresh()
      }

      function fetchConfig() {
        var run = lifecycle
        patch({ loading: !store.config, error: '' })
        fetch(apiUrl(), { credentials: 'same-origin' })
          .then(configResponse)
          .then(function (json) {
            if (run !== lifecycle) return
            adopt(json.config, json.path)
          })
          .catch(function () {
            if (run !== lifecycle) return
            patch({ loading: false, error: '读取设置失败' })
          })
      }

      // 同一时刻只发一个保存请求；在途时的改动只保留最新完整快照。
      function drainSaves() {
        if (saveInFlight || !pendingSave || !appCtx) return
        var cfg = pendingSave
        var run = lifecycle
        pendingSave = null
        saveInFlight = true
        fetch(apiUrl(), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(serialize(cfg))
        })
          .then(configResponse)
          .then(function (json) {
            if (run !== lifecycle) return
            saveInFlight = false
            if (pendingSave) {
              // 较早的保存结果不能覆盖用户随后做出的改动。
              drainSaves()
            } else {
              patch({ config: normalize(json.config), saving: false, dirty: false, error: '' })
              refresh()
            }
          })
          .catch(function () {
            if (run !== lifecycle) return
            saveInFlight = false
            // 保留包括排队改动在内的最新界面配置，等待用户重试，避免无限重发。
            pendingSave = store.config
            patch({ saving: false, dirty: true, error: '保存失败，当前改动尚未确认保存，请重试。' })
          })
      }

      function pushConfig(next) {
        var cfg = normalize(next)
        pendingSave = cfg
        patch({ config: cfg, saving: true, dirty: true, error: '' })
        refresh()
        drainSaves()
      }

      function retrySave() {
        if (!store.config || store.saving) return
        pushConfig(store.config)
      }

      function update(next) {
        pushConfig(normalize(next))
      }

      function closetsOf(cfg) {
        return (cfg && cfg.closets) || []
      }

      function findCloset(cfg, id) {
        var list = closetsOf(cfg)
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === id) return list[i]
        }
        return null
      }

      function closetOf(cfg, label) {
        var entries = (cfg && cfg.entries) || {}
        return Object.prototype.hasOwnProperty.call(entries, label) ? entries[label] : null
      }

      function membersOf(cfg, closetId) {
        var out = []
        var entries = (cfg && cfg.entries) || {}
        for (var label in entries) {
          if (!Object.prototype.hasOwnProperty.call(entries, label)) continue
          if (entries[label] === closetId) out.push(label)
        }
        return out
      }

      function signature(cfg) {
        var parts = []
        var list = closetsOf(cfg)
        for (var i = 0; i < list.length; i++) parts.push(list[i].id + ':' + list[i].name)
        var entries = (cfg && cfg.entries) || {}
        var keys = Object.keys(entries).sort()
        for (var k = 0; k < keys.length; k++) parts.push(keys[k] + '=' + String(entries[keys[k]]))
        return parts.join('|')
      }

      // ---------------------------------------------------------------- DOM

      function rowButtons() {
        try {
          return Array.prototype.slice.call(document.querySelectorAll(ROW_SELECTOR))
        } catch (err) {
          return []
        }
      }

      function labelOf(button) {
        return (button && button.getAttribute('aria-label')) || ''
      }

      function isOurs(button) {
        return !!(
          button &&
          (button.querySelector('[data-closet-head]') || button.querySelector('[data-closet-child]'))
        )
      }

      function discoverLabels() {
        var out = []
        var list = rowButtons()
        for (var i = 0; i < list.length; i++) {
          var button = list[i]
          if (isOurs(button)) continue
          var label = labelOf(button)
          if (!label || SYSTEM_LABELS.indexOf(label) >= 0) continue
          if (out.indexOf(label) < 0) out.push(label)
        }
        return out
      }

      // 侧栏上一行都还没渲染出来时不作判断（先按配置显示，等 DOM 变化再对齐）；
      // 一旦侧栏有行了，就只认还在的入口：插件停用后原行消失，匣里也不该留死行。
      function sideRowsReady() {
        try {
          return document.querySelectorAll(ROW_SELECTOR).length > 0
        } catch (err) {
          return false
        }
      }

      function liveMembersOf(cfg, closetId) {
        var members = membersOf(cfg, closetId)
        if (!sideRowsReady()) return members
        var live = discoverLabels()
        var out = []
        for (var i = 0; i < members.length; i++) {
          if (live.indexOf(members[i]) >= 0) out.push(members[i])
        }
        return out
      }

      // 原行只是被藏起来，程序化点一下照样能打开它自己的面板 —— 所以不用知道面板 id
      function clickByLabel(label) {
        var list = rowButtons()
        for (var i = 0; i < list.length; i++) {
          var button = list[i]
          if (isOurs(button)) continue
          if (labelOf(button) !== label) continue
          try {
            button.click()
            return true
          } catch (err) {
            return false
          }
        }
        return false
      }

      function openEntry(label) {
        if (!label) return
        if (clickByLabel(label)) patch({ activeLabel: label, notice: '' })
        else patch({ notice: '找不到「' + label + '」这个入口：插件可能没装，或者它改了名字。' })
      }

      // ---------------------------------------------------------------- styles

      function safeId(id) {
        return String(id).replace(/[^\w-]/g, '')
      }

      function syncStyles(cfg) {
        if (!styleEl) return
        var rules = []
        var list = closetsOf(cfg)
        var entries = (cfg && cfg.entries) || {}
        for (var i = 0; i < list.length; i++) {
          var id = safeId(list[i].id)
          rules.push(
            'html[data-closet-' + id + '="closed"] ' + ROW_SELECTOR + ':has([data-closet-child="' + id + '"]) { display: none !important }'
          )
          rules.push(
            'html[data-closet-' + id + '="open"] ' + ROW_SELECTOR + ':has([data-closet-child="' + id + '"]) { padding-left: 30px !important }'
          )
        }
        for (var label in entries) {
          if (!Object.prototype.hasOwnProperty.call(entries, label)) continue
          if (!entries[label]) continue
          rules.push(
            ROW_SELECTOR +
              '[aria-label="' +
              String(label).replace(/["\\]/g, '\\$&') +
              '"]:not(:has([data-closet-child])) { display: none !important }'
          )
        }
        rules.push(ROW_SELECTOR + ':has([data-closet-active]) { background: var(--dsw-alias-interactive-bg-hover) !important }')
        rules.push(
          'button[data-closet-ctl]:hover { background: var(--dsw-alias-interactive-bg-hover) !important; border-color: var(--dsw-alias-border-l4) !important }'
        )
        styleEl.textContent = rules.join('\n')
      }

      function syncAttrs(cfg) {
        var list = closetsOf(cfg)
        var root = document.documentElement
        for (var i = 0; i < list.length; i++) {
          try {
            root.setAttribute('data-closet-' + safeId(list[i].id), list[i].open ? 'open' : 'closed')
          } catch (err) {}
        }
      }

      // ---------------------------------------------------------------- icons

      function ClosetIcon(props) {
        var size = (props && props.size) || 18
        var active = !!(props && props.active)
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 2 : 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            style: { display: 'block', flex: 'none' }
          },
          h('rect', { x: 3.4, y: 6.6, width: 17.2, height: 12.4, rx: 1.4 }),
          h('path', { d: 'M3.4 10.2h17.2' }),
          h('rect', { x: 9.9, y: 8.9, width: 4.2, height: 4.4, rx: 0.7 }),
          h('path', { d: 'M12 13.3v2.4' })
        )
      }

      function iconKind(label) {
        var text = String(label || '')
        if (text.indexOf('设计') >= 0 || text.indexOf('歸藏') >= 0) return 'book'
        if (text.indexOf('便签') >= 0 || text.indexOf('笔记') >= 0) return 'note'
        if (text.indexOf('技能') >= 0 || text.indexOf('中心') >= 0) return 'grid'
        if (text.indexOf('统计') >= 0 || text.indexOf('Token') >= 0) return 'stats'
        return 'box'
      }

      function ItemIcon(props) {
        var kind = props && props.kind
        var size = (props && props.size) || 16
        var shape
        if (kind === 'book') {
          shape = [
            h('path', { d: 'M4 5.6c2.5-.9 5.3-.6 8 1.1 2.7-1.7 5.5-2 8-1.1v12.8c-2.5-.9-5.3-.6-8 1.1-2.7-1.7-5.5-2-8-1.1z' }),
            h('path', { d: 'M12 6.7v12.8' })
          ]
        } else if (kind === 'note') {
          shape = [
            h('path', { d: 'M6 3.8h8.9L19 7.9v12.3H6z' }),
            h('path', { d: 'M14.9 3.8v4.1H19' }),
            h('path', { d: 'M8.9 11.2h7.2' }),
            h('path', { d: 'M8.9 14.6h5.1' })
          ]
        } else if (kind === 'grid') {
          shape = [
            h('rect', { x: 3.9, y: 3.9, width: 6.7, height: 6.7, rx: 1.4 }),
            h('rect', { x: 13.4, y: 3.9, width: 6.7, height: 6.7, rx: 1.4 }),
            h('rect', { x: 3.9, y: 13.4, width: 6.7, height: 6.7, rx: 1.4 }),
            h('rect', { x: 13.4, y: 13.4, width: 6.7, height: 6.7, rx: 1.4 })
          ]
        } else if (kind === 'stats') {
          shape = [
            h('path', { d: 'M4 20.2h16' }),
            h('rect', { x: 5.6, y: 12.6, width: 3.2, height: 6.4, rx: 0.9, fill: 'currentColor', stroke: 'none' }),
            h('rect', { x: 10.4, y: 8.9, width: 3.2, height: 10.1, rx: 0.9, fill: 'currentColor', stroke: 'none', opacity: 0.62 }),
            h('rect', { x: 15.2, y: 5.2, width: 3.2, height: 13.8, rx: 0.9, fill: 'currentColor', stroke: 'none', opacity: 0.38 })
          ]
        } else {
          shape = [
            h('rect', { x: 4.4, y: 5.4, width: 15.2, height: 13.2, rx: 1.6 }),
            h('path', { d: 'M4.4 9.4h15.2' }),
            h('path', { d: 'M9.8 13h4.4' })
          ]
        }
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            style: { display: 'block', flex: 'none' }
          },
          shape
        )
      }

      // ---------------------------------------------------------------- 侧栏组件

      function ClosetHead(props) {
        var state = useStore()
        var cfg = state.config
        var id = props.closetId
        var closet = findCloset(cfg, id)
        var members = liveMembersOf(cfg, id)
        var open = !!(closet && closet.open)
        var holding = !!state.activeLabel && members.indexOf(state.activeLabel) >= 0 && !open
        return h(
          'span',
          {
            'data-closet-head': id,
            title: (open ? '收起' : '展开') + '「' + ((closet && closet.name) || '匣') + '」',
            style: {
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              height: '100%'
            }
          },
          h(ClosetIcon, { size: props.size || 18, active: open || holding }),
          holding
            ? h('span', {
                style: {
                  position: 'absolute',
                  right: 1,
                  top: 1,
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: C.accent
                }
              })
            : null
        )
      }

      function ClosetChild(props) {
        var state = useStore()
        var label = props.label
        var attrs = {
          'data-closet-child': props.closetId,
          'data-closet-child-label': label,
          title: label,
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%'
          }
        }
        if (state.activeLabel === label) attrs['data-closet-active'] = '1'
        return h('span', attrs, h(ItemIcon, { kind: iconKind(label), size: Math.max(14, (props.size || 18) - 1) }))
      }

      function ClosetHome(props) {
        var state = useStore()
        var cfg = state.config
        var id = props.closetId
        var closet = findCloset(cfg, id)
        var members = liveMembersOf(cfg, id)
        var missing = membersOf(cfg, id).length - members.length
        return h(
          'div',
          { style: { padding: '22px 24px', font: 'inherit', color: C.text } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '「' + ((closet && closet.name) || '匣') + '」'),
          h(
            'div',
            { style: { fontSize: 12, color: C.text3, margin: '6px 0 14px', lineHeight: 1.6 } },
            '侧栏那一行点开就是这个盒子；下面这些是收在里面的入口。'
          ),
          members.length
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 320 } },
                members.map(function (label) {
                  return h(
                    'button',
                    {
                      key: label,
                      type: 'button',
                      onClick: function () {
                        openEntry(label)
                      },
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        height: 34,
                        padding: '0 10px',
                        font: 'inherit',
                        fontSize: 13,
                        textAlign: 'left',
                        color: C.text2,
                        background: 'transparent',
                        border: '1px solid ' + C.line,
                        borderRadius: 8,
                        cursor: 'pointer'
                      }
                    },
                    h(ItemIcon, { kind: iconKind(label), size: 16 }),
                    h('span', null, label)
                  )
                })
              )
            : h('div', { style: { fontSize: 12, color: C.text3 } }, '这个匣还是空的，去 设置 → 匣 里放点东西进来。'),
          missing > 0
            ? h(
                'div',
                { style: { fontSize: 11.5, color: C.text3, marginTop: 10, lineHeight: 1.6 } },
                '另外 ' +
                  String(missing) +
                  ' 个入口在侧栏里找不到（插件可能停用了），暂时不显示；插件恢复后会自己回来。'
              )
            : null
        )
      }

      // 从「更多」菜单点到匣里的某一项时，先用它把点击转回原行
      function RedirectEntry(props) {
        var label = props.label
        React.useEffect(function () {
          openEntry(label)
        }, [label])
        return null
      }

      // ---------------------------------------------------------------- 设置页

      var sectionStyle = {
        padding: '4px 2px 20px',
        font: 'inherit',
        color: C.text,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        maxWidth: 780
      }

      function inputStyle() {
        return {
          height: 30,
          padding: '0 9px',
          font: 'inherit',
          fontSize: 13,
          color: C.text,
          background: C.bg2,
          border: '1px solid ' + C.line2,
          borderRadius: 7,
          outline: 'none'
        }
      }

      function smallButton(extra) {
        var style = {
          height: 28,
          minWidth: 30,
          padding: '0 9px',
          font: 'inherit',
          fontSize: 12,
          color: C.text2,
          background: C.bg2,
          border: '1px solid ' + C.line2,
          borderRadius: 7,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center'
        }
        var key
        for (key in extra || {}) {
          if (Object.prototype.hasOwnProperty.call(extra, key)) style[key] = extra[key]
        }
        return style
      }

      function Card(props) {
        return h(
          'div',
          {
            style: {
              border: '1px solid ' + C.line,
              borderRadius: 12,
              background: C.bg1,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10
            }
          },
          props.children
        )
      }

      function NameField(props) {
        var pair = React.useState(props.value)
        var draft = pair[0]
        var setDraft = pair[1]
        React.useEffect(function () {
          setDraft(props.value)
        }, [props.value])
        return h('input', {
          value: draft,
          onChange: function (event) {
            setDraft(event.target.value)
          },
          onBlur: function () {
            var next = String(draft || '').trim()
            if (next && next !== props.value) props.onCommit(next)
            else setDraft(props.value)
          },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && event.currentTarget) event.currentTarget.blur()
            if (event.key === 'Escape') {
              setDraft(props.value)
              if (event.currentTarget) event.currentTarget.blur()
            }
          },
          style: inputStyle(),
          'aria-label': '匣的名字'
        })
      }

      function SettingsSection() {
        var state = useStore()
        var cfg = state.config

        React.useEffect(function () {
          if (!store.config && !store.loading) fetchConfig()
        }, [])

        if (state.loading && !cfg) {
          return h('div', { style: sectionStyle }, h('div', { style: { fontSize: 12, color: C.text3 } }, '读取中…'))
        }
        if (!cfg) {
          return h(
            'div',
            { style: sectionStyle },
            h('div', { style: { fontSize: 13, color: C.text2 } }, state.error || '读取设置失败'),
            h('button', { type: 'button', 'data-closet-ctl': '1', onClick: fetchConfig, style: smallButton({ alignSelf: 'flex-start' }) }, '重试')
          )
        }

        var closets = closetsOf(cfg)
        var entries = cfg.entries || {}
        var discovered = discoverLabels()
        var labels = []
        var i
        for (i = 0; i < discovered.length; i++) labels.push(discovered[i])
        for (var label in entries) {
          if (Object.prototype.hasOwnProperty.call(entries, label) && labels.indexOf(label) < 0) labels.push(label)
        }

        function assign(name, closetId) {
          var nextEntries = {}
          var key
          for (key in entries) {
            if (Object.prototype.hasOwnProperty.call(entries, key)) nextEntries[key] = entries[key]
          }
          nextEntries[name] = closetId
          update({ version: 1, closets: cfg.closets, entries: nextEntries })
        }

        function rename(id, name) {
          var next = closets.map(function (item) {
            if (item.id !== id) return item
            return { id: item.id, name: name, open: item.open }
          })
          update({ version: 1, closets: next, entries: entries })
        }

        function removeCloset(id) {
          var nextClosets = closets.filter(function (item) {
            return item.id !== id
          })
          var nextEntries = {}
          var key
          for (key in entries) {
            if (!Object.prototype.hasOwnProperty.call(entries, key)) continue
            nextEntries[key] = entries[key] === id ? null : entries[key]
          }
          update({ version: 1, closets: nextClosets, entries: nextEntries })
        }

        function moveCloset(id, delta) {
          var at = -1
          for (var j = 0; j < closets.length; j++) {
            if (closets[j].id === id) at = j
          }
          var to = at + delta
          if (at < 0 || to < 0 || to >= closets.length) return
          var next = closets.slice()
          var moved = next.splice(at, 1)[0]
          next.splice(to, 0, moved)
          update({ version: 1, closets: next, entries: entries })
        }

        function addCloset() {
          var max = 0
          for (var j = 0; j < closets.length; j++) {
            var m = /^c(\d+)$/.exec(closets[j].id)
            if (m) max = Math.max(max, Number(m[1]))
          }
          var next = closets.concat([
            { id: 'c' + String(max + 1), name: '匣 ' + String(closets.length + 1), open: false }
          ])
          update({ version: 1, closets: next, entries: entries })
        }

        var closetRows = []
        for (i = 0; i < closets.length; i++) {
          ;(function (closet) {
            var count = membersOf(cfg, closet.id).length
            closetRows.push(
              h(
                'div',
                {
                  key: closet.id,
                  style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px' }
                },
                h(ClosetIcon, { size: 16 }),
                h(NameField, {
                  value: closet.name,
                  onCommit: function (name) {
                    rename(closet.id, name)
                  }
                }),
                h('span', { style: { fontSize: 11, color: C.text3, minWidth: 36 } }, String(count) + ' 项'),
                h('button', { type: 'button', 'data-closet-ctl': '1', onClick: function () { moveCloset(closet.id, -1) }, style: smallButton(), title: '上移' }, '↑'),
                h('button', { type: 'button', 'data-closet-ctl': '1', onClick: function () { moveCloset(closet.id, 1) }, style: smallButton(), title: '下移' }, '↓'),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-closet-ctl': '1',
                    onClick: function () { removeCloset(closet.id) },
                    style: smallButton({ color: C.danger }),
                    title: '删除这个匣；里面的入口会回到匣外'
                  },
                  '删除'
                )
              )
            )
          })(closets[i])
        }

        var entryRows = []
        for (i = 0; i < labels.length; i++) {
          ;(function (name) {
            var current = closetOf(cfg, name)
            var known = discovered.indexOf(name) >= 0
            entryRows.push(
              h(
                'div',
                {
                  key: name,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    height: 42,
                    borderTop: i === 0 ? 'none' : '1px solid ' + C.line
                  }
                },
                h(ItemIcon, { kind: iconKind(name), size: 16 }),
                h('span', { style: { fontSize: 13, color: C.text } }, name),
                known ? null : h('span', { style: { fontSize: 11, color: C.text3 } }, '侧栏里没找到，可能没装'),
                h(
                  'select',
                  {
                    value: current || '__out',
                    onChange: function (event) {
                      var value = event.target.value
                      assign(name, value === '__out' ? null : value)
                    },
                    style: {
                      marginLeft: 'auto',
                      height: 28,
                      minWidth: 138,
                      padding: '0 8px',
                      font: 'inherit',
                      fontSize: 12,
                      color: C.text2,
                      background: C.bg2,
                      border: '1px solid ' + C.line,
                      borderRadius: 7,
                      outline: 'none'
                    },
                    'aria-label': '把「' + name + '」放到哪里'
                  },
                  h('option', { value: '__out' }, '放在匣外'),
                  closets.map(function (item) {
                    return h('option', { key: item.id, value: item.id }, '放进「' + item.name + '」')
                  })
                )
              )
            )
          })(labels[i])
        }

        return h(
          'div',
          { style: sectionStyle },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '匣'),
          h(
            'div',
            { style: { fontSize: 12, color: C.text3, lineHeight: 1.7 } },
            '把侧栏里的第三方入口收进小盒子。可以新建、改名、删除匣，用右边的下拉框决定每个入口放在哪个匣、还是放回外面。官方那几行（插件、自动化任务、更多）不参与搬运。'
          ),
          state.error
            ? h(
                'div',
                { role: 'alert', style: { fontSize: 12, color: C.danger, lineHeight: 1.7 } },
                h('div', null, state.error),
                h('button', {
                  type: 'button',
                  'data-closet-ctl': '1',
                  onClick: state.dirty ? retrySave : fetchConfig,
                  style: smallButton({ marginTop: 6 })
                }, state.dirty ? '重试保存' : '重试')
              )
            : h('div', { role: 'status', style: { fontSize: 12, color: C.text3 } }, state.saving ? '保存中…' : '已保存'),
          h(
            Card,
            null,
            h('div', { style: { fontSize: 12, color: C.text2, fontWeight: 600 } }, '匣的名单'),
            closetRows,
            h(
              'button',
              { type: 'button', 'data-closet-ctl': '1', onClick: addCloset, style: smallButton({ alignSelf: 'flex-start', color: C.accent }) },
              '＋ 新建一个匣'
            )
          ),
          h(
            Card,
            null,
            h('div', { style: { fontSize: 12, color: C.text2, fontWeight: 600 } }, '入口放在哪里'),
            h('div', { style: { fontSize: 11.5, color: C.text3 } }, '新装的第三方入口默认在匣外；选进匣之后它就会收起来。'),
            entryRows.length
              ? entryRows
              : h('div', { style: { fontSize: 12, color: C.text3 } }, '侧栏上暂时没有可收的第三方入口。')
          ),
          state.notice
            ? h(
                'div',
                {
                  style: {
                    fontSize: 12,
                    color: C.text3,
                    border: '1px solid ' + C.line,
                    borderRadius: 9,
                    padding: '9px 11px',
                    background: C.bg1
                  }
                },
                state.notice
              )
            : null,
          h(
            'div',
            { style: { fontSize: 11, color: C.text3, lineHeight: 1.7 } },
            '设置只存在这台电脑上：' + (store.filePath || '<DSH_HOME>/config/dsh-closet.json')
          )
        )
      }

      // ---------------------------------------------------------------- 侧栏注册

      function disposeRows() {
        for (var i = 0; i < rowHandles.length; i++) {
          try {
            rowHandles[i]()
          } catch (err) {}
        }
        rowHandles = []
      }

      function keep(handle) {
        if (typeof handle === 'function') rowHandles.push(handle)
      }

      function rebuildRows(cfg) {
        disposeRows()
        var ctx = appCtx
        if (!ctx) return
        var closets = closetsOf(cfg)
        for (var i = 0; i < closets.length; i++) {
          ;(function (closet, index) {
            var headOrder = 5 + index * 10
            var members = liveMembersOf(cfg, closet.id)
            keep(
              ctx.slots.inject('sidebar.panellist', function () {
                return ctx.slots.register(
                  {
                    name: 'sidebar.panellist',
                    id: 'closet-head-' + closet.id,
                    order: headOrder,
                    label: function () {
                      return '「' + closet.name + '」' + (members.length ? ' ' + String(members.length) : '')
                    },
                    inject: function () {
                      return { closetId: closet.id }
                    }
                  },
                  ClosetHead
                )
              })
            )
            for (var k = 0; k < members.length; k++) {
              ;(function (label, slot) {
                var rowId = 'closet-item-' + closet.id + '-' + String(slot + 1)
                keep(
                  ctx.slots.inject('sidebar.panellist', function () {
                    return ctx.slots.register(
                      {
                        name: 'sidebar.panellist',
                        id: rowId,
                        order: headOrder + 0.1 * (slot + 1),
                        label: function () {
                          return label
                        },
                        inject: function () {
                          return { closetId: closet.id, label: label }
                        }
                      },
                      ClosetChild
                    )
                  })
                )
                keep(
                  ctx.slots.inject('main', function () {
                    return ctx.slots.register(
                      {
                        name: 'main',
                        key: rowId,
                        inject: function () {
                          return { label: label }
                        }
                      },
                      RedirectEntry
                    )
                  })
                )
              })(members[k], k)
            }
            keep(
              ctx.slots.inject('main', function () {
                return ctx.slots.register(
                  {
                    name: 'main',
                    key: 'closet-head-' + closet.id,
                    inject: function () {
                      return { closetId: closet.id }
                    }
                  },
                  ClosetHome
                )
              })
            )
          })(closets[i], i)
        }
      }

      function refresh() {
        if (!appCtx || !store.config) return
        var cfg = store.config
        syncAttrs(cfg)
        syncStyles(cfg)
        // 侧栏上实际还有哪些入口也算进签名：插件停用/启用时即使配置没变也要重画
        var sig = signature(cfg) + '\u0001' + discoverLabels().join('\u0000')
        if (sig !== lastSignature) {
          lastSignature = sig
          rebuildRows(cfg)
        }
      }

      // ---------------------------------------------------------------- apply

      function toggleCloset(id) {
        var cfg = store.config
        if (!cfg) return
        var closets = cfg.closets.map(function (item) {
          if (item.id !== id) return item
          return { id: item.id, name: item.name, open: !item.open }
        })
        update({ version: 1, closets: closets, entries: cfg.entries })
      }

      function apply(ctx) {
        appCtx = ctx
        var run = ++lifecycle
        pendingSave = null
        saveInFlight = false
        lastSignature = ''
        patch({ loading: true, config: null, error: '', notice: '', saving: false, dirty: false, activeLabel: '' })

        ctx.effect(function () {
          return function () {
            if (run !== lifecycle) return
            lifecycle++
            pendingSave = null
            saveInFlight = false
            appCtx = null
            disposeRows()
          }
        }, 'dsh-closet: pending saves')

        ctx.effect(function () {
          if (typeof MutationObserver !== 'function' || !document.body) return
          var scheduled = false
          var lastLive = discoverLabels().join('\u0000')
          var observer = new MutationObserver(function (records) {
            // 只有“侧栏那种行”增删才关心，避免聊天流式输出把这里拖慢
            var relevant = false
            for (var i = 0; i < records.length && !relevant; i++) {
              var nodes = [].concat(
                Array.prototype.slice.call(records[i].addedNodes || []),
                Array.prototype.slice.call(records[i].removedNodes || [])
              )
              for (var j = 0; j < nodes.length; j++) {
                var node = nodes[j]
                if (!node || node.nodeType !== 1) continue
                if ((node.matches && node.matches(ROW_SELECTOR)) || (node.querySelector && node.querySelector(ROW_SELECTOR))) {
                  relevant = true
                  break
                }
              }
            }
            if (!relevant || scheduled) return
            scheduled = true
            setTimeout(function () {
              scheduled = false
              if (run !== lifecycle || !appCtx || !store.config) return
              var live = discoverLabels().join('\u0000')
              if (live === lastLive) return
              lastLive = live
              refresh()
            }, 60)
          })
          observer.observe(document.body, { childList: true, subtree: true })
          return function () {
            try {
              observer.disconnect()
            } catch (err) {}
          }
        }, 'dsh-closet: sidebar rows watcher')

        ctx.effect(function () {
          var style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-closet')
          document.head.appendChild(style)
          styleEl = style
          if (store.config) syncStyles(store.config)
          return function () {
            try {
              style.remove()
            } catch (err) {}
            styleEl = null
          }
        }, 'dsh-closet: styles')

        ctx.effect(function () {
          function swallow(event) {
            event.preventDefault()
            event.stopPropagation()
            if (event.stopImmediatePropagation) event.stopImmediatePropagation()
          }
          function onClick(event) {
            var target = event && event.target
            if (!target || typeof target.closest !== 'function') return
            var button = target.closest('button')
            if (!button) return
            var head = button.querySelector('[data-closet-head]')
            if (head) {
              swallow(event)
              toggleCloset(head.getAttribute('data-closet-head'))
              return
            }
            var child = button.querySelector('[data-closet-child]')
            if (child) {
              swallow(event)
              openEntry(child.getAttribute('data-closet-child-label') || '')
              return
            }
            if ((button.getAttribute('class') || '').indexOf('panelRow') >= 0 && !isOurs(button)) {
              patch({ activeLabel: '', notice: '' })
            }
          }
          document.addEventListener('click', onClick, true)
          return function () {
            document.removeEventListener('click', onClick, true)
          }
        }, 'dsh-closet: clicks')

        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: 'closet', order: 26, label: function () { return '匣' } },
            SettingsSection
          )
        })

        fetchConfig()
      }

      var module = { exports: {} }
      var exports = module.exports
      exports.isPlugin = true
      exports.inject = ['slots', 'layout']
      exports.apply = apply
      return module.exports
    }
  })
}
