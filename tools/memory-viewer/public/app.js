const state = {
  q: '',
  persona: '__all__',
  kind: '',
  range: '',
  sort: 'default',
  pinned: false,
  deleted: false,
  limit: 50,
  offset: 0,
  total: 0,
  selectedId: null,
  entries: new Map(),
}

const $ = id => document.getElementById(id)

const KIND_LABEL = { profile: 'profile', fact: 'fact', episode: 'episode' }

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  }[character]))
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDateTime(ms) {
  if (typeof ms !== 'number')
    return '—'
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatRelative(ms) {
  if (typeof ms !== 'number')
    return ''
  const diff = Date.now() - ms
  const minute = 60_000
  if (diff < minute)
    return '刚刚'
  if (diff < 60 * minute)
    return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute)
    return `${Math.floor(diff / (60 * minute))} 小时前`
  const days = Math.floor(diff / (24 * 60 * minute))
  if (days < 30)
    return `${days} 天前`
  if (days < 365)
    return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

function query(extra = {}) {
  const params = new URLSearchParams()
  if (state.q)
    params.set('q', state.q)
  if (state.persona && state.persona !== '__all__')
    params.set('persona', state.persona)
  if (state.kind)
    params.set('kind', state.kind)
  if (state.sort && state.sort !== 'default')
    params.set('sort', state.sort)
  if (state.pinned)
    params.set('pinned', '1')
  if (state.deleted)
    params.set('deleted', '1')
  if (state.range) {
    const days = Number(state.range)
    params.set('from', String(Date.now() - days * 86_400_000))
  }
  for (const [key, value] of Object.entries(extra))
    params.set(key, String(value))
  return params
}

/* ---------------- charts ---------------- */

function renderDaily(daily) {
  const host = $('chart-daily')
  if (!daily?.length) {
    host.innerHTML = '<p class="panel-note">暂无数据</p>'
    return
  }

  const width = 600
  const height = 132
  const padX = 10
  const padTop = 16
  const padBottom = 20
  const innerWidth = width - padX * 2
  const innerHeight = height - padTop - padBottom
  const max = Math.max(1, ...daily.map(item => item.count))
  const slot = innerWidth / daily.length
  const barWidth = Math.max(3, slot - 3)

  const bars = daily.map((item, index) => {
    const ratio = item.count / max
    const barHeight = item.count === 0 ? 2 : Math.max(4, ratio * innerHeight)
    const x = padX + index * slot + (slot - barWidth) / 2
    const y = padTop + innerHeight - barHeight
    const fill = item.count === 0 ? '#eef0f4' : '#4f46e5'
    const opacity = item.count === 0 ? 1 : 0.35 + ratio * 0.65
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3" fill="${fill}" opacity="${opacity}"><title>${esc(item.day)} · ${item.count} 条</title></rect>`
  }).join('')

  const axis = [0, Math.floor(daily.length / 2), daily.length - 1]
    .map((index) => {
      const item = daily[index]
      const x = padX + index * slot + slot / 2
      return `<text x="${x.toFixed(1)}" y="${height - 4}" text-anchor="middle" font-size="9.5" fill="#8a92a1">${esc(item.day.slice(5))}</text>`
    })
    .join('')

  host.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="近 30 天每天更新的记忆条数">
      <line x1="${padX}" y1="${padTop + innerHeight}" x2="${width - padX}" y2="${padTop + innerHeight}" stroke="#eceef2" stroke-width="1" />
      <text x="${padX}" y="10" font-size="9.5" fill="#8a92a1">峰值 ${max}</text>
      ${bars}
      ${axis}
    </svg>`
}

function renderBars(hostId, items, tone) {
  const host = $(hostId)
  if (!items?.length) {
    host.innerHTML = '<p class="panel-note">暂无数据</p>'
    return
  }
  const max = Math.max(1, ...items.map(item => item.count))
  host.innerHTML = `<div class="bar-row">${items.map((item) => {
    const width = Math.max(3, Math.round((item.count / max) * 100))
    return `<div class="bar-item" title="${esc(item.label)} · ${item.count} 条">
      <span class="bar-name">${esc(item.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${width}%;background:${tone}"></span></span>
      <span class="bar-count">${item.count}</span>
    </div>`
  }).join('')}</div>`
}

/* ---------------- stats ---------------- */

function renderStats(meta) {
  $('stat-active').textContent = meta.active
  $('stat-pinned').textContent = meta.pinned
  $('stat-general').textContent = meta.general
  $('stat-deleted').textContent = meta.deleted
  $('stat-personas').textContent = meta.personas.length

  $('stat-range').textContent = meta.firstAt
    ? `最早 ${formatDateTime(meta.firstAt).slice(0, 10)}`
    : '—'
  $('stat-last').textContent = meta.lastAt ? `最近写入 ${formatRelative(meta.lastAt)}` : '—'

  $('db-path').textContent = meta.dbPath
  $('db-path').title = meta.dbPath
  $('db-readonly').textContent = meta.readOnly ? '只读连接' : 'query_only'

  renderDaily(meta.daily)
  const dailyTitle = document.querySelector('#chart-daily')
    ?.closest('.panel')
    ?.querySelector('h2')
  if (dailyTitle && meta.dailyDays)
    dailyTitle.textContent = `近 ${meta.dailyDays} 天活跃度`
  renderBars('chart-kinds', meta.kinds.map(item => ({ label: KIND_LABEL[item.kind] ?? item.kind, count: item.count })), '#4f46e5')
  renderBars(
    'chart-personas',
    meta.personas.map(item => ({ label: item.persona === '__general__' ? '（通用）' : item.persona, count: item.count })),
    '#0d9488',
  )

  const select = $('filter-persona')
  const current = select.value
  const personaOptions = meta.personas
    .filter(item => item.persona !== '__general__')
    .map(item => `<option value="${esc(item.persona)}">${esc(item.persona)}（${item.count}）</option>`)
    .join('')
  const generalOption = meta.general ? `<option value="__general__">（通用记忆）（${meta.general}）</option>` : ''
  select.innerHTML = `<option value="__all__">全部角色</option>${personaOptions}${generalOption}`
  select.value = [...select.options].some(option => option.value === current) ? current : '__all__'
  state.persona = select.value
}

/* ---------------- rows ---------------- */

function importanceDots(value) {
  const dots = Array.from({ length: 5 }, (_, index) => `<span class="imp-dot${index < value ? ' on' : ''}"></span>`).join('')
  return `<span class="imp">${dots}<span class="imp-num">${value}</span></span>`
}

function renderRows(payload) {
  const body = $('rows')
  const empty = $('empty')
  const entries = payload.entries

  state.entries.clear()
  for (const entry of entries)
    state.entries.set(entry.id, entry)

  if (!entries.length) {
    body.innerHTML = ''
    empty.hidden = false
  }
  else {
    empty.hidden = true
    body.innerHTML = entries.map((entry) => {
      const kind = entry.kind
      const persona = entry.persona
        ? `<span class="persona-pill" title="${esc(entry.persona)}">${esc(entry.persona)}</span>`
        : '<span class="persona-pill general">通用</span>'
      const deleted = typeof entry.deletedAt === 'number'
      const preview = entry.body && entry.body !== entry.description
        ? `<div class="desc-sub">${esc(entry.body.slice(0, 120))}</div>`
        : ''
      return `<tr data-id="${esc(entry.id)}" class="${deleted ? 'is-deleted' : ''}${state.selectedId === entry.id ? ' is-selected' : ''}">
        <td class="time-cell">${esc(formatDateTime(entry.updatedAt))}<small>${esc(formatRelative(entry.updatedAt))}</small></td>
        <td><div class="desc-strong">${esc(entry.description)}${deleted ? '<span class="tag-deleted">已删除</span>' : ''}</div>${preview}</td>
        <td>${persona}</td>
        <td><span class="kind-badge kind-${esc(kind)}">${esc(kind)}</span></td>
        <td>${importanceDots(entry.importance)}</td>
        <td class="use-cell">${entry.useCount || '—'}</td>
        <td>${entry.source ? `<span class="source-pill">${esc(entry.source)}</span>` : '<span class="use-cell">—</span>'}</td>
      </tr>`
    }).join('')
  }

  const from = payload.total === 0 ? 0 : payload.offset + 1
  const to = Math.min(payload.offset + payload.limit, payload.total)
  $('pager-info').textContent = `第 ${from}–${to} 条 / 共 ${payload.total} 条`
  $('btn-prev').disabled = payload.offset <= 0
  $('btn-next').disabled = payload.offset + payload.limit >= payload.total
}

/* ---------------- drawer ---------------- */

function openDrawer(entry) {
  state.selectedId = entry.id
  $('drawer-kind').className = `kind-badge kind-${entry.kind}`
  $('drawer-kind').textContent = entry.kind
  $('drawer-title').textContent = entry.description || '（无描述）'
  $('drawer-body').textContent = entry.body || '（空）'
  $('drawer-id').textContent = entry.id

  const rows = [
    ['角色', entry.persona || '通用（所有角色可见）'],
    ['类型', entry.kind],
    ['重要度', `${entry.importance} / 5`],
    ['置顶', entry.pinned ? '是' : '否'],
    ['来源', entry.source || '—'],
    ['创建时间', formatDateTime(entry.createdAt)],
    ['更新时间', formatDateTime(entry.updatedAt)],
    ['最后使用', formatDateTime(entry.lastUsedAt)],
    ['使用次数', entry.useCount ?? 0],
    ['状态', typeof entry.deletedAt === 'number' ? `已删除 · ${formatDateTime(entry.deletedAt)}` : '生效中'],
  ]
  if (entry.supersededBy)
    rows.push(['被替代为', entry.supersededBy])
  if (entry.embeddingModel)
    rows.push(['向量模型', entry.embeddingModel])

  $('drawer-meta').innerHTML = rows
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`)
    .join('')

  const sessionBlock = $('drawer-session-block')
  if (entry.sourceSessionId) {
    sessionBlock.hidden = false
    $('drawer-session').textContent = entry.sourceSessionId
  }
  else {
    sessionBlock.hidden = true
  }

  $('drawer').hidden = false
  $('scrim').hidden = false
  document.querySelectorAll('.grid tbody tr').forEach((row) => {
    row.classList.toggle('is-selected', row.dataset.id === entry.id)
  })
}

function closeDrawer() {
  state.selectedId = null
  $('drawer').hidden = true
  $('scrim').hidden = true
  document.querySelectorAll('.grid tbody tr').forEach(row => row.classList.remove('is-selected'))
}

/* ---------------- data ---------------- */

function describeError(error) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
}

async function fetchMeta() {
  const response = await fetch('/api/meta')
  if (!response.ok)
    throw new Error(`meta ${response.status}`)
  return await response.json()
}

async function fetchList() {
  const params = query({ limit: state.limit, offset: state.offset })
  const response = await fetch(`/api/memories?${params}`)
  if (!response.ok)
    throw new Error(`memories ${response.status}`)
  return await response.json()
}

/** One counter for every refresh, so a slow response cannot overwrite a newer one. */
let listToken = 0

async function refresh({ keepOffset = false } = {}) {
  if (!keepOffset)
    state.offset = 0
  const token = ++listToken
  try {
    const [meta, payload] = await Promise.all([fetchMeta(), fetchList()])
    if (token !== listToken)
      return
    renderStats(meta)
    state.total = payload.total
    renderRows(payload)
  }
  catch (error) {
    if (token === listToken)
      $('pager-info').textContent = `读取失败：${describeError(error)}`
  }
}

/* ---------------- events ---------------- */

function debounce(fn, delay) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(fn, delay, ...args)
  }
}

const onSearch = debounce(() => {
  state.q = $('search').value.trim()
  refresh()
}, 260)

$('search').addEventListener('input', onSearch)

$('filter-persona').addEventListener('change', (event) => {
  state.persona = event.target.value
  refresh()
})

$('filter-kind').addEventListener('change', (event) => {
  state.kind = event.target.value
  refresh()
})

$('filter-range').addEventListener('change', (event) => {
  state.range = event.target.value
  refresh()
})

$('filter-sort').addEventListener('change', (event) => {
  state.sort = event.target.value
  refresh()
})

$('filter-pinned').addEventListener('change', (event) => {
  state.pinned = event.target.checked
  refresh()
})

$('filter-deleted').addEventListener('change', (event) => {
  state.deleted = event.target.checked
  refresh()
})

$('page-size').addEventListener('change', (event) => {
  state.limit = Number(event.target.value)
  refresh()
})

$('btn-prev').addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - state.limit)
  refresh({ keepOffset: true })
})

$('btn-next').addEventListener('click', () => {
  state.offset = state.offset + state.limit
  refresh({ keepOffset: true })
})

$('btn-refresh').addEventListener('click', () => {
  closeDrawer()
  refresh()
})

$('btn-export-json').addEventListener('click', () => {
  window.location.href = `/api/export?format=json&${query()}`
})

$('btn-export-csv').addEventListener('click', () => {
  window.location.href = `/api/export?format=csv&${query()}`
})

$('rows').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-id]')
  if (!row)
    return
  const entry = state.entries.get(row.dataset.id)
  if (entry)
    openDrawer(entry)
})

$('drawer-close').addEventListener('click', closeDrawer)
$('scrim').addEventListener('click', closeDrawer)

$('btn-copy').addEventListener('click', async () => {
  const button = $('btn-copy')
  const restore = () => {
    button.textContent = '复制正文'
  }
  try {
    await navigator.clipboard.writeText($('drawer-body').textContent ?? '')
    button.textContent = '已复制'
  }
  catch {
    button.textContent = '复制失败'
  }
  setTimeout(restore, 1400)
})

document.addEventListener('keydown', (event) => {
  const typing = /^(?:INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')
  if (event.key === '/' && !typing) {
    event.preventDefault()
    $('search').focus()
  }
  if (event.key === 'Escape')
    closeDrawer()
})

refresh()
