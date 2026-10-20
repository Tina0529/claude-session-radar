import type { Register } from 'claude-code'

// ── 内部参数（用户可调的在 plugin.json 的 userConfig 里，见 README「修改配置」）──
const SYNC_MS = 2000            // 各 session 对齐「看板开/关」的间隔
const PANE = 'session-radar'
const PREF = 'pref:paneOpen'    // 看板开关状态：跨 session 共享，切换 session 时保持
const NOTICE_MAX = 3            // 横条上的快速切换栏：窄窗口一列最多几个「跑完还没看」的 session（够宽时两列，翻倍）
const TWO_COL_MIN = 80          // 横条宽度（字符列数）达到这个值就排成两列
const hideKey = (id: string) => `hide:${id}`   // 在横条上点 × 收起（这个 session 下次跑完会再出现）
const seenKey = (id: string) => `seen:${id}`   // 已看过的完成提示（跨 session 共享，点过一处其他地方也消失）
const LOG = 'log'               // 诊断日志：每轮结束是否通知、播音结果
// ── token 用量 ───────────────────────────────────────────
const USAGE_MS = 60000          // 用量数据刷新间隔
const TAB = 'pref:paneTab'      // 看板标签页：sessions | usage（跨 session 共享）
const SUB = 'pref:sessTab'      // 会话页的分类：todo | run | pin | all（跨 session 共享）
const PINS = 'pins'             // 置顶的 session id 列表
const UNSEEN_MS = 86400_000     // 黄点（跑完未看）保留一天，过了就不算待处理
// 「你说」里不算用户原话的系统消息：后台任务通知、子 agent 消息、App 重启续跑等
const isNoise = (t: string) => /^\s*(<|\[Request interrupted|The app was quit|This session is being continued|Continue from where you left off)/i.test(t)
const RANGE = 'pref:usageRange' // 用量区间（跨 session 共享）
const RANGES: [string, string][] = [['today', '今天'], ['yesterday', '昨天'], ['7d', '7天'], ['30d', '30天'],
  ['month', '本月'], ['lastmonth', '上月'], ['all', '全部']]
const fmtTok = (n: number) => (n >= 1e8 ? `${(n / 1e8).toFixed(2)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : `${n}`)
const fmtUsd = (n: number) => `$${n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toFixed(2)}`
const base = (p: string) => p.split('/').filter(Boolean).pop() || p || '~'

type Rec = {
  id: string; localId?: string; project: string; title: string
  state: 'running' | 'background' | 'done' | 'aborted' | 'error'
  bg?: number                    // 主回合结束后仍在后台跑的 subagent 数
  at: number; startedAt: number; seconds: number; tools: number; turns: number
  ask?: string                   // 这一轮你最后发的话（摘要），通知里用来认出是哪个 session
  need?: 'decide' | 'send'       // 答完了，但 decide = 在等你拍板（提问 / 确认 / 选择 / 卡住）；send = 成果做好了，只差你发出去
}

const ICON: Record<Rec['state'], string> = { running: '⏳', background: '🔄', done: '✅', aborted: '⏹', error: '❌' }
const LABEL: Record<Rec['state'], string> = { running: '运行中', background: '后台运行中', done: '完成', aborted: '已中断', error: '出错' }
// 「完成」再细分：等你决定 / 待你发出（每轮答完时由小模型读回答判断）
const iconOf = (r: Rec) => (r.state === 'done' && r.need === 'decide' ? '🔴' : r.state === 'done' && r.need === 'send' ? '📤' : ICON[r.state])
const labelOf = (r: Rec) => (r.state === 'done' && r.need === 'decide' ? '等你决定' : r.state === 'done' && r.need === 'send' ? '待你发出' : LABEL[r.state])
// 越靠前越该先处理：等你决定 → 出错 / 中断 → 待你发出 → 完成
const urgency = (r: Rec) => (r.state === 'done' && r.need === 'decide' ? 0 : r.state === 'error' || r.state === 'aborted' ? 1 : r.state === 'done' && r.need === 'send' ? 2 : 3)

const TRIAGE_SYSTEM = [
  '你判断 AI 编程助手刚答完的一轮回答，用户接下来要做什么。只输出一个词：DECIDE、SEND 或 DONE。',
  'DECIDE：回答在等用户——向用户提问、请用户确认 / 选择 / 批准、问「要不要我…」，或者卡在需要用户处理的错误、权限、登录、手动操作上。',
  'SEND：成果已经做好，只差用户自己发出去 / 提交 / 发布（例如写好的邮件、消息、帖子草稿，或表单已填好、等用户点发表）。',
  'DONE：任务完成，没有需要用户决定或操作的事；只是顺带提一句「有需要可以再说」不算 DECIDE。',
].join('\n')
async function triage($: any, answer: string, model: string): Promise<Rec['need'] | undefined> {
  const text = String(answer || '').trim()
  if (!text) return undefined
  try {
    const r: any = await $.model.complete({ model, system: TRIAGE_SYSTEM, prompt: text.slice(-4000), maxTokens: 10, effort: 'low', timeoutMs: 20000 })
    const v = String(r?.text || '').toUpperCase()
    return v.includes('DECIDE') ? 'decide' : v.includes('SEND') ? 'send' : undefined
  } catch { return undefined }
}

// 用户配置（plugin.json 的 userConfig；`claude plugin configure` 修改），缺省值与 plugin.json 保持一致
type Cfg = { doneSound: string; errorSound: string; sound: boolean; notify: boolean; notifyMinSeconds: number; speak: boolean; keepDays: number; triage: boolean; triageModel: string }
function readCfg(o: any): Cfg {
  const num = (v: any, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d)
  const bool = (v: any, d: boolean) => (v === undefined || v === '' ? d : v === true || v === 'true')
  return {
    doneSound: String(o?.doneSound || 'Glass'),
    errorSound: String(o?.errorSound || 'Basso'),
    sound: bool(o?.sound, true),
    notify: bool(o?.notify, true),
    notifyMinSeconds: num(o?.notifyMinSeconds, 20),
    speak: bool(o?.speak, false),
    keepDays: num(o?.keepDays, 7) || 7,
    triage: bool(o?.triage, true),
    triageModel: String(o?.triageModel || 'haiku'),
  }
}

const key = (id: string) => `s:${id}`
const busy = (s: Rec['state']) => s === 'running' || s === 'background'   // 还没真正做完
// 显示名：优先 session 名（侧栏标题）；没有或是 App 自动起的通用标题（压缩后的续接等）就用文件夹名
const GENERIC_TITLE = /^(continuing previous conversation|new (session|conversation|chat)|untitled)/i
// 侧栏里的最新 session 名：每次发送消息时从桌面 App 的 session 列表读一次，存进各 session 共享的 store
// （侧栏改名后，在任意一个 session 里发一条消息，所有地方就都换成新名字）
const TITLES_KEY = 'titles'
let TITLES: Record<string, string> = {}
// 桌面 App 记录的「最后切到这个 session 的时刻」：切过去看过就算已读（和名字一起读，不单独轮询）
const FOCUS_KEY = 'focus'
let FOCUS: Record<string, number> = {}
const titleOf = (r: Rec) => TITLES[r.id] || r.title
const nameOf = (r: Rec) => { const t = titleOf(r); return t && !GENERIC_TITLE.test(t) ? t : r.project }
const READ_TITLES = [
  'import glob, json, os',
  'd, fo = {}, {}',
  'for f in glob.glob(os.path.expanduser("~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json")):',
  '    try:',
  '        j = json.load(open(f)); c = j.get("cliSessionId")',
  '        if c: d[c] = j.get("title") or ""; fo[c] = j.get("lastFocusedAt") or 0',
  '    except Exception: pass',
  'print(json.dumps({"titles": d, "focus": fo}, ensure_ascii=False))',
].join('\n')
async function readTitles($: any): Promise<{ titles: Record<string, string>; focus: Record<string, number> } | null> {
  try {
    const { exitCode, stdout } = await $.process.run(['/usr/bin/python3', '-c', READ_TITLES], { timeoutMs: 10000 })
    return exitCode === 0 ? JSON.parse(stdout) : null
  } catch { return null }
}
async function refreshTitles($: any) {
  const r = await readTitles($)
  if (r) { TITLES = r.titles; FOCUS = r.focus; await $.store.set(TITLES_KEY, r.titles); await $.store.set(FOCUS_KEY, r.focus) }
  return r?.titles ?? null
}
async function loadTitles($: any) {
  TITLES = ((await $.store.get(TITLES_KEY)) as Record<string, string> | undefined) ?? TITLES
  FOCUS = ((await $.store.get(FOCUS_KEY)) as Record<string, number> | undefined) ?? FOCUS
}
// 跑完以后还没看过（一天内）= 待处理：点过横条 / 看板、在里面发过消息、或在 App 里切过去看过，都算看过
async function isUnseen($: any, r: Rec, me: string | undefined, now: number) {
  if (r.id === me || busy(r.state) || r.turns === 0 || now - r.at >= UNSEEN_MS) return false
  const seen = Math.max(Number((await $.store.get(seenKey(r.id))) ?? 0), FOCUS[r.id] ?? 0)
  return r.at > seen
}
// 当前在看的 session（lastFocusedAt 最大的那个）
const focusedId = () => { let best = 0, id = ''; for (const [k, t] of Object.entries(FOCUS)) if (t > best) { best = t; id = k } return id }
const age = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}秒前` : s < 3600 ? `${Math.round(s / 60)}分钟前` : s < 86400 ? `${Math.round(s / 3600)}小时前` : `${Math.round(s / 86400)}天前`
}
const dur = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`)
const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ')

// 用引擎的 session ID 在 App 数据里查出侧栏用的 local_… ID 和侧栏标题
// 查不到 = 没有侧栏窗口（如 launchd 拉起的 claude -p 定时任务）
async function lookup($: any, cliId: string): Promise<{ localId?: string; title?: string }> {
  try {
    const { exitCode, stdout } = await $.process.run(['/bin/sh', '-c',
      'f=$(grep -rlF "$1" "$HOME/Library/Application Support/Claude/claude-code-sessions" 2>/dev/null | head -1); [ -n "$f" ] && cat "$f"',
      'sh', cliId], { timeoutMs: 10000 })
    if (exitCode !== 0 || !stdout) return {}
    const d = JSON.parse(stdout)
    return { localId: d.sessionId, title: d.title }
  } catch { return {} }
}

// 调用统计脚本（读本地 ~/.claude/projects 日志，去重 + 官方价目计价）；scan=true 时先增量扫描
async function fetchUsage($: any, ranges: string[], scan: boolean): Promise<any | null> {
  try {
    const args = ['/usr/bin/python3', `${$.plugin.root}/bin/usage.py`, 'summary']
    for (const r of ranges) args.push('--range', r)
    if (scan) args.push('--scan')
    const { exitCode, stdout } = await $.process.run(args, { timeoutMs: 600000 })
    return exitCode === 0 ? JSON.parse(stdout) : null
  } catch { return null }
}

// 这个 session 里还在跑的 subagent 数（后台调研等）；主回合结束时它们可能还没跑完
const LIVE = new Set(['pending', 'running', 'waiting'])
async function liveAgents($: any): Promise<number> {
  try { return (await $.agent.list()).filter((a: any) => LIVE.has(a.status)).length } catch { return 0 }
}

// 打开 / 收起看板，并把状态写进跨 session 的偏好
async function setPane($: any, open: boolean) {
  await $.store.set(PREF, open)
  const isUp = (await $.ui.panes()).some((p: any) => p.id === PANE)
  if (open && !isUp) await $.ui.open({ id: PANE, title: '最近 session' })
  if (!open && isUp) await $.ui.close({ id: PANE })
  $.ui.invalidate('ui.render')
}

// 每个 session 进程里的状态（顶层函数要读写，所以收在一个对象里传）
type St = {
  rec: Rec | null
  interactive: boolean
  tracked: boolean               // 只有「有窗口」的 session 才记录和提醒
  sync: { cancel: () => void } | null
  usage: any                     // 最近一次统计结果（含 today 和当前区间）
  usageAt: number
  usageBusy: boolean
  query: string                  // 看板会话页的搜索词（只在本 session 的看板里有效）
  cwd: string
  inTurn: boolean                // 正在跑一轮（初始化晚于回合开始时，用来把状态记成运行中）
  retry: { cancel: () => void } | null
  setupP: Promise<boolean> | null
}

// 同一个侧栏 session 续接 / 重开后，引擎的 session ID 会换，旧 ID 的记录会留下来（常常停在「运行中」）。
// 读的时候按侧栏 ID（localId）去重，只留最新的一条（当前 session 优先）
async function loadRecs($: any, me?: string): Promise<Rec[]> {
  const best = new Map<string, Rec>()
  for (const k of await $.store.keys()) {
    if (!k.startsWith('s:')) continue
    const r = (await $.store.get(k)) as Rec | undefined
    if (!r || !(r.localId || r.id === me)) continue   // 只列有窗口的 session
    const g = r.localId || r.id, cur = best.get(g)
    if (!cur || (r.id === me) || (cur.id !== me && r.at > cur.at)) best.set(g, r)
  }
  return [...best.values()]
}
// 写的时候清掉：同一个侧栏 session 的旧 ID 记录删除，置顶转到新 ID 上
async function dropStale($: any, keep: Rec) {
  if (!keep.localId) return
  let pins = ((await $.store.get(PINS)) as string[] | undefined) ?? []
  for (const k of await $.store.keys()) {
    if (!k.startsWith('s:') || k === key(keep.id)) continue
    const r = (await $.store.get(k)) as Rec | undefined
    if (!r || r.localId !== keep.localId) continue
    if (pins.includes(r.id)) pins = [...pins.filter(x => x !== r.id && x !== keep.id), keep.id]
    await $.store.delete(k); await $.store.delete(seenKey(r.id)); await $.store.delete(hideKey(r.id))
  }
  await $.store.set(PINS, pins)
}

// 认出「有窗口」的 session 并初始化。新建的 session 刚启动时，桌面 App 往往还没写好它的 local_*.json，
// 一次查不到不能就此放弃（否则整个 session 都不显示、不记录）：之后发消息、回合开始 / 结束时再查，
// 另外每 5 秒重试一次，最多 2 分钟
function ensureTracked($: any, st: St, cfg: Cfg): Promise<boolean> {
  if (st.tracked) return Promise.resolve(true)
  if (!st.setupP) st.setupP = setupTracking($, st, cfg).finally(() => { st.setupP = null })
  return st.setupP
}
async function setupTracking($: any, st: St, cfg: Cfg): Promise<boolean> {
  const id = await $.session.id()
  const now = await $.clock.now()
  const found = await lookup($, id)
  if (!(st.interactive || found.localId)) return false   // 无窗口的定时任务（或 App 还没写好记录）：先不做
  st.tracked = true
  st.retry?.cancel(); st.retry = null

  // 命令注册单独兜底：和内置命令重名会被引擎拒绝（曾因 /usage 撞名导致后面的初始化全部没跑）
  try { await $.command.register({ name: 'recent', description: '打开 / 收起「最近 session」看板' }) } catch { /* 忽略 */ }
  try { await $.command.register({ name: 'tokens', description: 'token 用量。/tokens 打开用量页；/tokens 2026-09-01 2026-09-30 看指定区间' }) }
  catch { try { await $.command.register({ name: 'radar-usage', description: 'token 用量（/tokens 被占用时的备用名）' }) } catch { /* 忽略 */ } }
  const old = (await $.store.get(key(id))) as Rec | undefined
  st.rec = old ?? { id, project: st.cwd.split('/').filter(Boolean).pop() || '~', title: '', state: st.inTurn ? 'running' : 'done', at: now, startedAt: now, seconds: 0, tools: 0, turns: 0 }
  if (found.localId) st.rec.localId = found.localId
  if (found.title) st.rec.title = found.title
  await $.store.set(key(st.rec.id), st.rec)
  await dropStale($, st.rec)

  // 清理：过期记录 + 以前误记的无窗口记录（没有侧栏 ID 的）
  for (const k of await $.store.keys()) {
    if (!k.startsWith('s:')) continue
    const r = (await $.store.get(k)) as Rec | undefined
    const pinnedIds = ((await $.store.get(PINS)) as string[] | undefined) ?? []   // 置顶的不过期
    if (!r || (now - r.at > cfg.keepDays * 86400_000 && !pinnedIds.includes(r.id)) || (!r.localId && r.id !== id)) await $.store.delete(k)
  }
  for (const k of await $.store.keys()) {   // 对应记录已删除的「已看过」标记
    if ((k.startsWith('seen:') || k.startsWith('hide:')) && (await $.store.get(`s:${k.slice(5)}`)) === undefined) await $.store.delete(k)
  }

  startSync($, st)
  $.ui.invalidate('ui.render')
  return true
}


// 每隔 SYNC_MS 对齐一次：看板开关跟随全局偏好；看板开着时顺便刷新内容
function startSync($: any, st: St) {
  st.sync?.cancel()
  st.sync = $.clock.every(SYNC_MS, async () => {
    const want = (await $.store.get(PREF)) === true
    const isUp = (await $.ui.panes()).some(p => p.id === PANE)
    if (want && !isUp) await $.ui.open({ id: PANE, title: '最近 session' })
    if (!want && isUp) await $.ui.close({ id: PANE })
    // 自己处于「后台运行中」时，跟踪后台 subagent 还剩几个；全部跑完就转成完成（唤醒后的那一轮会再正式提示）
    if (st.rec?.state === 'background') {
      const bg = await liveAgents($)
      if (bg !== st.rec.bg) {
        Object.assign(st.rec, bg > 0 ? { bg } : { bg: 0, state: 'done', at: await $.clock.now() })
        await $.store.set(key(st.rec.id), st.rec)
      }
    }
    // token 用量：每 USAGE_MS 刷新一次（今天 + 当前选中的区间）；扫描有文件锁，多个 session 不会重复扫
    const now = await $.clock.now()
    if (!st.usageBusy && now - st.usageAt > USAGE_MS) {
      st.usageBusy = true
      const range = String((await $.store.get(RANGE)) ?? 'today')
      const res = await fetchUsage($, Array.from(new Set(['today', range])), true)
      if (res) { st.usage = res; st.usageAt = now }
      st.usageBusy = false
    }
    $.ui.invalidate('ui.render')     // 横条也要跟上其他 session 的完成提示
  })
}

export const register: Register = (on, options) => {
  const cfg = readCfg(options)
  const st: St = { rec: null, interactive: false, tracked: false, sync: null, usage: null, usageAt: 0, usageBusy: false,
    query: '', cwd: '', inTurn: false, retry: null, setupP: null }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    st.interactive = e.isInteractive
    st.cwd = e.cwd || ''
    if (!(await ensureTracked($, st, cfg))) {
      let tries = 0
      st.retry?.cancel()
      st.retry = $.clock.every(5000, async () => {
        if ((await ensureTracked($, st, cfg)) || ++tries >= 24) { st.retry?.cancel(); st.retry = null }
      })
    }
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    st.inTurn = true
    await ensureTracked($, st, cfg)
    if (st.tracked && st.rec) {
      const now = await $.clock.now()
      const text = String((e as any).text ?? '').replace(/\s+/g, ' ').trim()
      if (!st.rec.title) st.rec.title = text.slice(0, 40)
      // 斜杠命令、空输入不覆盖上一次的摘要
      if (text && !text.startsWith('/') && !isNoise(text)) st.rec.ask = text.length > 36 ? `${text.slice(0, 36)}…` : text
      Object.assign(st.rec, { state: 'running', startedAt: now, at: now, tools: 0, need: undefined })
      await $.store.set(key(st.rec.id), st.rec)
      await $.store.set(seenKey(st.rec.id), now)   // 你已经在这个 session 里操作了，别处不用再提示它
    }
    const out = next(e)
    // 发送消息时刷新一次所有 session 的名字（不挡住消息发送）
    const tt = await refreshTitles($)
    if (tt && st.rec && tt[st.rec.id] && tt[st.rec.id] !== st.rec.title) { st.rec.title = tt[st.rec.id]; await $.store.set(key(st.rec.id), st.rec) }
    $.ui.invalidate('ui.render')
    return out
  })

  // 后台任务跑完会唤醒 session 再跑一轮，这种回合没有 prompt.submit，也要显示成运行中
  on('turn.start', async ($, e, next) => {
    if (!(e as any).agentId) st.inTurn = true
    await ensureTracked($, st, cfg)
    if (st.tracked && st.rec && st.rec.state !== 'running') {
      const now = await $.clock.now()
      Object.assign(st.rec, { state: 'running', startedAt: now, at: now, tools: 0, need: undefined })
      await $.store.set(key(st.rec.id), st.rec)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (st.rec) st.rec.tools += 1
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId) return out                    // 只管主回合，子 agent 的回合不提醒
    st.inTurn = false
    await ensureTracked($, st, cfg)
    if (!st.rec) return out
    await loadTitles($)
    const found = await lookup($, st.rec.id)
    if (found.localId && found.localId !== st.rec.localId) { st.rec.localId = found.localId; await dropStale($, st.rec) }
    if (found.title) st.rec.title = found.title
    st.tracked = st.interactive || !!st.rec.localId
    if (!st.tracked) return out

    const seconds = Math.round(e.durationMs / 1000)
    const bg = await liveAgents($)
    // 主回合答完但后台 subagent 还在跑 → 不算完成；等它们跑完、session 被唤醒再答完一轮时才提示「完成」
    const state: Rec['state'] = e.reason === 'answer' ? (bg > 0 ? 'background' : 'done') : e.reason === 'aborted' ? 'aborted' : 'error'
    // 正常答完时，让小模型读一下回答：是在等你拍板，还是只差你发出去，还是真做完了
    const need = state === 'done' && cfg.triage ? await triage($, String((e as any).answer ?? ''), cfg.triageModel) : undefined
    Object.assign(st.rec, { state, bg, seconds, at: await $.clock.now(), turns: st.rec.turns + 1, need })
    await $.store.set(key(st.rec.id), st.rec)
    // 跑完时读一次 App 的焦点：你正看着它跑完的，不算「没看」，不进别的 session 的横条
    if (await refreshTitles($) && focusedId() === st.rec.id) await $.store.set(seenKey(st.rec.id), st.rec.at)

    // 三行：是什么状态的哪个 session / 在哪个文件夹、花了多久 / 你最后让它做的事
    const head = `${iconOf(st.rec)} ${labelOf(st.rec)}｜${nameOf(st.rec)}`
    const meta = `📁 ${st.rec.project} · 用时 ${dur(seconds)} · 工具 ${st.rec.tools} 次${bg ? ` · 后台 ${bg} 个任务还在跑` : ''}`
    const ask = st.rec.ask ? `你说：「${st.rec.ask}」` : ''
    $.ui.toast([head, ask, meta].filter(Boolean).join('　'), { timeoutMs: 8000 })
    // 值得提醒：后台还在跑的先不响（跑完那轮再提示）；完成得很快的不打扰（你多半正盯着看）；出错/中断总是提醒
    const notify = state !== 'background' && (seconds >= cfg.notifyMinSeconds || state !== 'done')
    let notifyRc = -1, soundRc = -1, soundErr = ''
    if (notify && cfg.notify) {
      // 文字通知：不带声音（声音由下面直接播放）。terminal-notifier 的通知点一下直接打开这个 session；
      // osascript 的通知点了只会打开「脚本编辑器」，所以只作没装 terminal-notifier 时的退路
      const url = st.rec.localId ? `claude://code/continue?session=${st.rec.localId}&source=desktop_action` : ''
      try {
        // 找 terminal-notifier（Homebrew 两种位置都试）；通知右侧的 Claude 图标从本机 Claude.app 生成一次后缓存
        notifyRc = (await $.process.run(['/bin/sh', '-c',
          'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; n=$(command -v terminal-notifier) || exit 127; ' +
          'i="$HOME/.claude/session-radar-data/claude.png"; ' +
          '[ -f "$i" ] || { mkdir -p "${i%/*}"; c=$(ls /Applications/Claude.app/Contents/Resources/*.icns 2>/dev/null | head -1); ' +
          '[ -n "$c" ] && sips -s format png -Z 128 "$c" --out "$i" >/dev/null 2>&1; }; ' +
          '[ -f "$i" ] && set -- "$@" -contentImage "$i"; exec "$n" "$@"', 'sh',
          '-title', head, '-subtitle', meta, '-message', ask || '（点击打开这个 session）',
          '-group', `session-radar:${st.rec.id}`,
          ...(url ? ['-open', url] : ['-activate', 'com.anthropic.claudefordesktop']),
        ], { timeoutMs: 10000 })).exitCode
      } catch { notifyRc = -2 }
      if (notifyRc !== 0) {
        try {
          notifyRc = 100 + (await $.process.run(['osascript', '-e',
            `display notification "${esc(ask || meta)}" with title "${esc(head)}" subtitle "${esc(meta)}"`])).exitCode
        } catch { notifyRc = -3 }
      }
    }
    if (notify && cfg.sound) {
      // 提示音：afplay 直接播放（不交给通知系统决定出不出声）。
      // 配置可写绝对路径，或名字：先找 ~/Library/Sounds/<名字>.{aiff,wav,mp3,m4a,caf}，再找系统音效
      try {
        const r = await $.process.run(['/bin/sh', '-c',
          'f="$1"; if [ ! -f "$f" ]; then for x in aiff wav mp3 m4a caf; do [ -f "$HOME/Library/Sounds/$1.$x" ] && f="$HOME/Library/Sounds/$1.$x" && break; done; fi; ' +
          '[ -f "$f" ] || f="/System/Library/Sounds/$1.aiff"; [ -f "$f" ] || f="/System/Library/Sounds/Glass.aiff"; exec /usr/bin/afplay "$f"',
          'sh', state === 'done' ? cfg.doneSound : cfg.errorSound], { timeoutMs: 15000 })
        soundRc = r.exitCode; soundErr = (r.stderr || '').slice(0, 120)
      } catch (err) { soundRc = -2; soundErr = String(err).slice(0, 120) }
    }
    if (notify && cfg.speak) $.ui.speak(`${nameOf(st.rec)} ${labelOf(st.rec)}`).catch(() => {})
    // 诊断日志：最近 50 条，存在共享存储的 log 键里
    const log = ((await $.store.get(LOG)) as any[] | undefined) ?? []
    log.push({ at: await $.clock.now(), name: nameOf(st.rec), state, seconds, notify, notifyRc, soundRc, soundErr })
    await $.store.set(LOG, log.slice(-50))
    st.usageAt = 0                      // 这一轮刚花了 token：下一个同步周期立刻刷新用量
    $.ui.invalidate('ui.render')
    return out
  })

  // 用户点看板自带的 ✕ 关掉时，也记成「收起」，其他 session 跟着收起
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set(PREF, false)
    return next(e)
  })

  // /recent：和横条按钮一样，开着就收起，收着就打开
  on('command.run', { command: 'recent' }, async $ => {
    const open = (await $.store.get(PREF)) !== true
    await setPane($, open)
    return { text: open ? '已打开「最近 session」看板。' : '已收起「最近 session」看板。' }
  })

  // /tokens [起 止]：打开看板的用量页；带两个日期就看那个区间（/radar-usage 是备用名）
  for (const name of ['tokens', 'radar-usage']) on('command.run', { command: name }, async ($, e) => {
    const m = String(e.args ?? '').match(/(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/)
    if (m) await $.store.set(RANGE, `${m[1]}:${m[2]}`)
    await $.store.set(TAB, 'usage')
    await setPane($, true)
    const range = String((await $.store.get(RANGE)) ?? 'today')
    const res = await fetchUsage($, Array.from(new Set(['today', range])), false)
    if (res) { st.usage = res; st.usageAt = await $.clock.now() }
    $.ui.invalidate('ui.render')
    return { text: m ? `已打开用量页：${m[1]} ~ ${m[2]}` : '已打开用量页。指定区间：/tokens 2026-09-01 2026-09-30' }
  })

  // 输入框正上方的横条：最近 1 小时的状况摘要 + 看板开关按钮
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await loadTitles($)
    if (!st.tracked || e.props.hasSurvey) return next(e)   // 有问卷占用横条时让路
    const below = await next(e)   // 下层插件（比如 voice-reply）画的内容，包在自己下面一起显示
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const isOpen = (await $.store.get(PREF)) === true
    const me = st.rec?.id
    const n = { done: 0, error: 0, aborted: 0, running: 0, background: 0 }
    const notices: Rec[] = []
    for (const r of await loadRecs($, me)) {
      if (!r.localId) continue
      if (busy(r.state) || now - r.at < 3600_000) n[r.state] += 1
      // 快速切换栏：只列跑完以后你还没看过的；看过（切过去 / 点过 / 发过消息）就不再占位
      if (!(await isUnseen($, r, me, now))) continue
      if (r.at <= Number((await $.store.get(hideKey(r.id))) ?? 0)) continue
      notices.push(r)
    }
    // 等你决定 → 出错 / 中断 → 待你发出 → 完成，同类按跑完的先后
    notices.sort((a, b) => urgency(a) - urgency(b) || b.at - a.at)
    // 横条够宽就排两列、多放一倍；名字太长截短，免得把一格撑破
    const twoCol = Number(e.props.bodyColumns ?? 0) >= TWO_COL_MIN
    const max = twoCol ? NOTICE_MAX * 2 : NOTICE_MAX
    const short = (t: string) => (t.length > 16 ? `${t.slice(0, 15)}…` : t)
    return (
      <Box flexDirection="column">
        <Box key="notices" flexDirection="row" flexWrap="wrap">
          {notices.slice(0, max).map(r => (
            <Box key={`n-${r.id}`} flexDirection="row" width={twoCol ? '50%' : '100%'}>
              <Button key={`open-${r.id}`} label={`${iconOf(r)} ${short(nameOf(r))} · ${labelOf(r)} ↗`} onPress={async () => {
                await $.store.set(seenKey(r.id), r.at)
                void $.process.run(['open', `claude://code/continue?session=${r.localId}&source=desktop_action`])
                $.ui.invalidate('ui.render')
              }} />
              <Box key={`meta-${r.id}`} flexShrink={1}><Text dimColor wrap="truncate-end"> 📁 {r.project} · {age(now - r.at)}</Text></Box>
              <Button key={`dismiss-${r.id}`} label="×" onPress={async () => {
                await $.store.set(seenKey(r.id), r.at)
                await $.store.set(hideKey(r.id), r.at)
                $.ui.invalidate('ui.render')
              }} />
            </Box>
          ))}
        </Box>
        {notices.length > max && <Text key="more" dimColor>  还有 {notices.length - max} 个没看，在看板「待处理」里</Text>}
        {/* 统计行：左边是自己的统计，右边接下层插件（比如 voice-reply 的「🔊 朗读 · 声音」），窄时自动换行 */}
        <Box key="stats-row" flexDirection="row" flexWrap="wrap" justifyContent="space-between">
        <Box key="stats" flexDirection="row">
          <Button key="radar-toggle" label={isOpen ? '▾ 看板' : '▸ 看板'}
            onPress={() => setPane($, !isOpen)} />
          <Text dimColor> 近1小时 </Text>
          <Text color="green">✅{n.done} </Text>
          {n.error + n.aborted > 0 && <Text color="red">❌{n.error + n.aborted} </Text>}
          {n.running > 0 && <Text color="yellow">⏳{n.running} </Text>}
          {n.background > 0 && <Text color="cyan">🔄{n.background} </Text>}
          {st.usage?.ranges?.today && (
            <Text dimColor> · 今天 {fmtTok(st.usage.ranges.today.totals.total)} token ≈ {fmtUsd(st.usage.ranges.today.totals.cost)}</Text>
          )}
        </Box>
        {below ? <Box key="below">{below}</Box> : null}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await loadTitles($)
    const { Box, Text, Button, Input } = $.ui.resolve(e) as any
    const now = await $.clock.now()
    const me = st.rec?.id
    const tab = String((await $.store.get(TAB)) ?? 'sessions')
    const tabs = (
      <Box key="tabs" flexDirection="row" marginBottom={1}>
        <Button key="tab-s" label={tab === 'sessions' ? '● 会话' : '会话'} onPress={async () => {
          await $.store.set(TAB, 'sessions'); $.ui.invalidate('ui.render')
        }} />
        <Button key="tab-u" label={tab === 'usage' ? '● 用量' : '用量'} onPress={async () => {
          await $.store.set(TAB, 'usage'); $.ui.invalidate('ui.render')
        }} />
        {tab === 'sessions' && Input && <Input key="search" placeholder="🔍 搜索名字 / 文件夹 / 你说" value={st.query} submitLabel="搜索"
          onInput={(v: string) => { st.query = v; $.ui.invalidate('ui.render') }}
          onSubmit={(v: string) => { st.query = v; $.ui.invalidate('ui.render') }} />}
      </Box>
    )

    // ── 用量页 ──────────────────────────────────────────
    if (tab === 'usage') {
      const range = String((await $.store.get(RANGE)) ?? 'today')
      const u = st.usage?.ranges?.[range]
      const width = Math.max(20, (e.props?.bodyColumns ?? 60) - 4)
      const barMax = Math.max(8, Math.min(24, width - 30))
      const days: any[] = u?.byDay ?? []
      const maxDay = Math.max(1, ...days.map(d => d.cost))
      const custom = !RANGES.some(([k]) => k === range)
      return (
        <Box flexDirection="column">
          {tabs}
          <Box key="ranges" flexDirection="row" flexWrap="wrap">
            {RANGES.map(([k, label]) => (
              <Button key={`r-${k}`} label={range === k ? `●${label}` : label} onPress={async () => {
                await $.store.set(RANGE, k)
                const res = await fetchUsage($, Array.from(new Set(['today', k])), false)
                if (res) { st.usage = res; st.usageAt = await $.clock.now() }
                $.ui.invalidate('ui.render')
              }} />
            ))}
            <Button key="r-refresh" label="↻" onPress={async () => {
              const res = await fetchUsage($, Array.from(new Set(['today', range])), true)
              if (res) { st.usage = res; st.usageAt = await $.clock.now() }
              $.ui.invalidate('ui.render')
            }} />
          </Box>
          {custom && <Text key="custom" color="cyan">自定义区间（/tokens 起 止 修改）</Text>}
          {!u && <Text key="loading" dimColor>统计中…（首次打开或切换区间需要一两秒）</Text>}
          {u && (
            <Box key="sum" flexDirection="column" marginTop={1}>
              <Text dimColor>{u.from === u.to ? u.from : `${u.from} ~ ${u.to}`} · 请求 {u.totals.requests.toLocaleString('en-US')} 次</Text>
              <Text><Text bold>{fmtTok(u.totals.total)} token</Text>  ≈ <Text bold color="green">{fmtUsd(u.totals.cost)}</Text></Text>
              <Text dimColor wrap="truncate-end">输入 {fmtTok(u.totals.input)} · 输出 {fmtTok(u.totals.output)} · 缓存写 {fmtTok(u.totals.cacheWrite)} · 缓存读 {fmtTok(u.totals.cacheRead)}</Text>
            </Box>
          )}
          {u && days.length > 1 && (
            <Box key="days" flexDirection="column" marginTop={1}>
              <Text bold>按天</Text>
              {days.slice(-31).map(d => (
                <Text key={`d-${d.day}`} wrap="truncate-end">
                  <Text dimColor>{d.day.slice(5)} </Text>
                  <Text color="cyan">{'█'.repeat(Math.max(1, Math.round((d.cost / maxDay) * barMax)))}</Text>
                  <Text> {fmtUsd(d.cost)}</Text><Text dimColor> {fmtTok(d.total)}</Text>
                </Text>
              ))}
            </Box>
          )}
          {u && u.byModel.length > 0 && (
            <Box key="models" flexDirection="column" marginTop={1}>
              <Text bold>按模型</Text>
              {u.byModel.map((m: any) => (
                <Text key={`m-${m.model}`} wrap="truncate-end">
                  {m.model.replace(/^claude-/, '').replace(/-\d{8}$/, '')}  <Text bold>{fmtUsd(m.cost)}</Text>
                  <Text dimColor>  {u.totals.cost > 0 ? Math.round((m.cost / u.totals.cost) * 100) : 0}% · {fmtTok(m.total)}</Text>
                </Text>
              ))}
            </Box>
          )}
          {u && u.byProject.length > 0 && (
            <Box key="projects" flexDirection="column" marginTop={1}>
              <Text bold>按项目（前 10）</Text>
              {u.byProject.map((p: any) => (
                <Text key={`p-${p.project}`} wrap="truncate-end">
                  📁 {base(p.project)}  <Text bold>{fmtUsd(p.cost)}</Text><Text dimColor>  {fmtTok(p.total)}</Text>
                </Text>
              ))}
            </Box>
          )}
          {u && u.unpriced.length > 0 && <Text key="unpriced" color="yellow">未计价模型：{u.unpriced.join(', ')}</Text>}
          <Text key="foot" dimColor wrap="wrap">
            按 Anthropic 官方 API 标价折算（Max 订阅非实际账单）· 已去重{st.usage?.lastScan ? ` · 更新于 ${age(now - st.usage.lastScan)}` : ''}
          </Text>
        </Box>
      )
    }

    // ── 会话页 ──────────────────────────────────────────
    const all: Rec[] = await loadRecs($, me)   // 只列有窗口的 session，同一个侧栏 session 只留一条
    const pins = ((await $.store.get(PINS)) as string[] | undefined) ?? []
    const pinned = (r: Rec) => pins.includes(r.id)
    all.sort((a, b) => b.at - a.at)
    const color = (r: Rec) => (r.state === 'done' ? (r.need === 'decide' ? 'red' : r.need === 'send' ? 'magenta' : 'green') : r.state === 'running' ? 'yellow' : r.state === 'background' ? 'cyan' : r.state === 'error' ? 'red' : 'gray')

    // 跑完后还没回去看过（一天内）的 session 标黄点 = 待处理（和横条的完成提示共用「已看过」标记）
    const unseen = new Set<string>()
    for (const r of all) {
      if (await isUnseen($, r, me, now)) unseen.add(r.id)
    }
    const groups: Record<string, Rec[]> = {
      // 待处理 = 跑完没看过的 + 还在等你决定的（看过但还没回它），等你决定的排前面
      todo: all.filter(r => unseen.has(r.id) || (r.id !== me && r.state === 'done' && r.need === 'decide')).sort((a, b) => urgency(a) - urgency(b) || b.at - a.at),
      run: all.filter(r => busy(r.state)),
      pin: all.filter(pinned),
      all: [...all.filter(pinned), ...all.filter(r => !pinned(r))],
    }
    const stored = (await $.store.get(SUB)) as string | undefined
    const sub = stored && groups[stored] ? stored : (groups.todo.length ? 'todo' : 'all')
    const SUBS: [string, string][] = [['todo', '待处理'], ['run', '运行中'], ['pin', '★ 置顶'], ['all', '全部']]
    const subTabs = (
      <Box key="subtabs" flexDirection="row" flexWrap="wrap" marginBottom={1}>
        {SUBS.map(([k, label]) => (
          <Button key={`sub-${k}`} label={`${sub === k ? '● ' : ''}${label} ${groups[k].length}`} dimColor={sub !== k} onPress={async () => {
            await $.store.set(SUB, k); $.ui.invalidate('ui.render')
          }} />
        ))}
      </Box>
    )
    const EMPTY: Record<string, string> = { todo: '没有待处理的 session 🎉', run: '现在没有在跑的 session', pin: '还没有置顶。点每行末尾的 ☆ 钉住常用的 session', all: '还没有记录。跑一轮对话后这里会出现。' }
    // 有搜索词时：在全部 session 里按名字 / 文件夹 / 你说 / 侧栏标题过滤（不分标签页，置顶的排前）
    const q = st.query.trim().toLowerCase()
    const hit = (r: Rec) => [nameOf(r), titleOf(r), r.project, r.ask ?? ''].some(x => x.toLowerCase().includes(q))
    const list = q ? groups.all.filter(hit) : groups[sub]
    const rows = list.slice(0, Math.max(3, (e.viewport?.rows ?? 30) - 6))
    let hot = 0                       // 可跳转的前 9 行配数字快捷键（看板有焦点时按 1-9）

    return (
      <Box flexDirection="column">
        {tabs}
        {q
          ? <Box key="searching" flexDirection="row" marginBottom={1}>
              <Text dimColor>搜索「{st.query.trim()}」：{list.length} 个  </Text>
              <Button key="clear-q" label="× 清空" onPress={() => { st.query = ''; $.ui.invalidate('ui.render') }} />
            </Box>
          : subTabs}
        {rows.length === 0 && <Text dimColor>{q ? '没有匹配的 session' : EMPTY[sub]}</Text>}
        {rows.map(r => {
          const canOpen = r.id !== me && !!r.localId
          const key = canOpen && hot < 9 ? String(++hot) : undefined
          // 标题行：整行就是按钮，点名字直接切过去；年龄放在按钮里，所以必须给固定 key
          const title = [
            unseen.has(r.id) && <Text key="dot" color="yellow">● </Text>,
            <Text key="st" color={color(r)} bold>{iconOf(r)} {r.state === 'done' && !r.need ? '' : `${labelOf(r)}${r.state === 'background' && r.bg ? ` ${r.bg}` : ''} `}</Text>,
            <Text key="nm" bold>{nameOf(r)}</Text>,
            r.id === me && <Text key="me" color="cyan"> (当前)</Text>,
            <Text key="age" dimColor>  {age(now - r.at)}{canOpen ? '  ↗' : ''}</Text>,
          ].filter(Boolean)            // 按钮里只能放 Text，false 要先去掉
          const meta = r.turns === 0 && !busy(r.state)
            ? '还没跑过'
            : `${r.state === 'running' ? '进行中' : r.state === 'background' ? `主回合 ${dur(r.seconds)}，后台 ${r.bg ?? '?'} 个任务在跑` : `用时 ${dur(r.seconds)}`} · 工具 ${r.tools} 次${r.ask && !isNoise(r.ask) ? ` · 你说「${r.ask}」` : ''}`
          return (
            <Box key={r.id} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row">
                {canOpen
                  ? <Button key={`go-${r.id}`} plain hotkey={key} onPress={async () => {
                      await $.store.set(seenKey(r.id), r.at)
                      void $.process.run(['open', `claude://code/continue?session=${r.localId}&source=desktop_action`])
                      $.ui.invalidate('ui.render')
                    }}>{title}</Button>
                  : <Text>{title}</Text>}
                <Button key={`pin-${r.id}`} plain dimColor={!pinned(r)} label={pinned(r) ? ' ★' : ' ☆'} onPress={async () => {
                  const cur = ((await $.store.get(PINS)) as string[] | undefined) ?? []
                  await $.store.set(PINS, cur.includes(r.id) ? cur.filter(x => x !== r.id) : [...cur, r.id])
                  $.ui.invalidate('ui.render')
                }} />
              </Box>
              <Text dimColor wrap="truncate-end">{'   '}📁 {r.project} · {meta}</Text>
            </Box>
          )
        })}
        <Text key="hint" dimColor>点名字直接切过去 · ☆ 置顶 · 黄点 = 一天内跑完还没看 · 🔄 = 后台 subagent 还在跑</Text>
      </Box>
    )
  })
}
