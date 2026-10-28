/**
 * dsh-plain-approvals —— 把「需要你许可」与「向你提问」的界面文字改写成大白话。
 *
 * 机制（基于 DSH 内部 seam，实测为准）：
 *  - 审批：`approval/request` 是 Cordis waterfall。浏览器审批面板（dsh-client-ui-approval）
 *    与 Host 之间的桥接发生在 `dsh-api-remotes` 的 waterfall 监听器里；我们在它前面
 *    （prepend）拿到同一个 request 对象，改写 `displayReason` 后再 next()。
 *    `displayReason` 只影响展示，不改动审计用的 `reason`，也不改结果。
 *  - 提问：`user-questions/request` 同理。我们用当前模型把 question / header /
 *    option.description 改写得更通俗；**label 原样保留**，因为用户选中的 label 会
 *    原样回传给模型，改写 label 会改变回答词汇。
 *  - 风险分级：审批请求本身不携带工具参数（文档明确），所以我们在 `tools/pre-execute`
 *    上按 callId 缓存本次调用的 arguments，再用它判断「读取 / 写入 / 删除」并提取文件路径。
 *    缓存按会话隔离（不同窗口的调用不会串台），带 TTL 与字节上限，不会无限变大。
 *  - 套娃命令：`bash -c "rm -rf x"`、`python -c "..."`、`pwsh -Command ...`、
 *    `powershell -EncodedCommand <base64>` 会递归展开看真实命令，但**深度、字符数、
 *    展开次数三重预算封顶**：遇到无限套娃时浅尝辄止，绝不进死循环。
 *  - 日志：异步落盘、队列有界、超限轮转，绝不阻塞主流程。
 *
 * 文案全部放在 `locale/*.json`，代码只负责组装；缺 key 时回落到英文。
 * 所有路径都 fail-open：任何异常都放行原始内容，绝不因为本插件卡住或拦下操作。
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-plain-approvals'
export const inject = []

/** 构建标记：用于在运行日志里确认当前加载的是哪一版（跟随 package.json）。 */
function readBuild() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? `v${manifest.version}` : 'v0'
  } catch {
    return 'v0'
  }
}

const BUILD = readBuild()

/** 语言包：`locale/<id>.json`，只读，不随会话变化。 */
function loadLocale(id) {
  try {
    return JSON.parse(readFileSync(new URL(`../locale/${id}.json`, import.meta.url), 'utf8'))
  } catch {
    return {}
  }
}

const LOCALES = { zh: loadLocale('zh'), en: loadLocale('en') }
const FALLBACK_LOCALE = 'en'

/**
 * 取一条文案并填入占位符。缺少的 key 回落到英文，英文也没有就返回空串
 * （宁可少一句，也不显示 `{placeholder}` 之类的东西）。
 *
 * @param locale - `zh` / `en`。
 * @param key - 语言包里的键。
 * @param vars - `{name}` 占位符的取值。
 * @returns 组装好的文案。
 */
function t(locale, key, vars = {}) {
  const table = LOCALES[locale] ?? LOCALES[FALLBACK_LOCALE] ?? {}
  const fallback = LOCALES[FALLBACK_LOCALE] ?? {}
  const template = typeof table[key] === 'string' ? table[key] : fallback[key]
  if (typeof template !== 'string') return ''
  return template.replace(/\{(\w+)\}/g, (whole, name) => (typeof vars[name] === 'string' ? vars[name] : whole))
}

/**
 * 诊断日志：**异步**写，绝不阻塞主流程。
 *
 * - 调用方只往内存队列里塞一行就立刻返回，由串行的 drain 写盘；
 * - 队列有界：满了就丢并记 dropped，内存不会无限涨；
 * - 文件超限轮转成 `.1`，不会长成几百 MB；
 * - 任何失败都静默——日志不是功能的一部分。
 *
 * 只记工具名 / 模式 / 结果 / 路径条数，不记命令正文与问题正文。
 */
const LOG_MAX_BYTES = 2 * 1024 * 1024
const LOG_QUEUE_MAX = 500
const logQueue = []
let logDrainPromise = null
let logDropped = 0

/** 日志文件位置；测试用 `DSH_PLAIN_APPROVALS_LOG` 指到临时文件，避免污染真实日志。 */
function logFile() {
  return process.env.DSH_PLAIN_APPROVALS_LOG || join(homedir(), '.dsh', 'dsh-plain-approvals.log')
}

/**
 * 记一行日志（不等待落盘）。
 *
 * @param line - 日志行。
 */
export function debugLog(line) {
  if (logQueue.length >= LOG_QUEUE_MAX) {
    logDropped += 1
    return
  }
  logQueue.push(`${new Date().toISOString()} ${line}\n`)
  if (logDrainPromise === null) void flushLog()
}

/** 把队列里现有的行写出去；出错静默。 */
async function drainLog() {
  try {
    while (logQueue.length > 0) {
      let batch = logQueue.splice(0, logQueue.length).join('')
      if (logDropped > 0) {
        batch += `${new Date().toISOString()} log queue overflow: ${logDropped} line(s) dropped\n`
        logDropped = 0
      }
      const target = logFile()
      await mkdir(dirname(target), { recursive: true })
      await appendFile(target, batch, 'utf8')
      await rotateLog(target)
    }
  } catch {
    // 日志失败不影响插件行为
  }
}

/**
 * 等到队列真的写空。生产代码不需要调用；测试用它避免「断言时文件还没写完」。
 * 连跑多轮：写的过程中新进来的行也会被写掉。
 *
 * @returns 队列为空即 resolve 的 Promise。
 */
export async function flushLog() {
  while (logQueue.length > 0 || logDrainPromise !== null) {
    if (logDrainPromise === null) {
      logDrainPromise = drainLog().finally(() => {
        logDrainPromise = null
      })
    }
    await logDrainPromise
  }
}

/** 文件超过上限就转成 `.1` 一份，别让它无限长。 */
async function rotateLog(target) {
  try {
    const info = await stat(target)
    if (info.size <= LOG_MAX_BYTES) return
    const previous = `${target}.1`
    await rm(previous, { force: true })
    await rename(target, previous)
  } catch {
    // 轮转失败就继续追加，下一次再试
  }
}

/**
 * 当前缓存与日志队列的规模。诊断用，也被测试用来盯住「内存不能无限涨」。
 *
 * @returns `{ calls, callBytes, rewrites, rewriteBytes, logQueued, logDropped }`。
 */
export function cacheStats() {
  return {
    calls: toolArgsByCallId.size,
    callBytes: toolArgsBytes,
    rewrites: rewriteCache.size,
    rewriteBytes: rewriteCacheBytes,
    logQueued: logQueue.length,
    logDropped,
  }
}

const SANDBOX_REASON_RE = /^escalate sandbox to ([a-z-]+):([\s\S]*)$/
const MAX_ORIGINAL_CHARS = 600
const MAX_PATHS = 8
const REWRITE_TIMEOUT_MS = 15_000
const REWRITE_MAX_TOKENS = 2000

/* ── 缓存上限：多个 AI 窗口同时干活时，内存和状态都不能失控 ─────────────── */

/** 最多记多少个工具调用参数（超出按最旧的淘汰）。 */
const MAX_CACHED_CALLS = 256
/** 缓存条目的总字节上限；超了就从最旧的开始丢。 */
const MAX_CACHED_ARG_BYTES = 2 * 1024 * 1024
/** 一次审批从发生到用户点按钮通常就几十秒，留 5 分钟足够，过期即视为无效。 */
const CALL_TTL_MS = 5 * 60_000
/** 提问改写缓存的条数与总字节上限、TTL。 */
const MAX_CACHED_REWRITES = 64
const MAX_CACHED_REWRITE_BYTES = 512 * 1024
const REWRITE_TTL_MS = 10 * 60_000

/* ── 套娃命令展开的预算：宁可少看一层，也不能把机器转死 ─────────────────── */

/** 最多往下展开几层（0 只有外层：bash -c "…" 算第 1 层）。 */
const MAX_NEST_DEPTH = 3
/** 一次分级最多处理多少个字符（含所有展开出来的内层脚本）。 */
const MAX_NEST_CHARS = 4000
/** 一次分级最多展开多少个子脚本，防止「一层里塞 500 个 bash -c」。 */
const MAX_NEST_OPENINGS = 24

/** 中文（含扩展 A）判定：含有这些字符的文本视为已是中文。 */
const HAS_CJK = /[\u3400-\u9fff]/

/** 只读类工具。 */
const READ_TOOLS = new Set([
  'read',
  'read_image',
  'read_file',
  'list_dir',
  'list_files',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
])

/** 会新增 / 覆盖内容、但不以删除为目的的工具。 */
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'create_file',
  'str_replace_editor',
  'str-replace-editor',
])

/** 删除类工具。 */
const DELETE_TOOLS = new Set([
  'delete_file',
  'remove_file',
  'move_file',
  'rename_file',
])

/** 命令类工具：只能按命令文本启发式判断。 */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'cmd', 'powershell'])

/**
 * 删除类动词。这些词作为「一条命令的第一个词」出现时按删除处理；
 * 长写法的 PowerShell cmdlet 在命令任意位置出现也算。
 */
const DESTRUCTIVE_VERBS = new Set([
  'rm',
  'del',
  'erase',
  'rmdir',
  'rd',
  'ri',
  'remove-item',
  'shred',
  'sdelete',
  'deltree',
  'format',
  'dd',
  'mkfs',
  'unlink',
  'truncate',
  'clear-content',
  'clc',
  'rmtree',
])

/** 写入 / 移动类动词（作为第一个词出现时按写入处理）。 */
const WRITE_VERBS = new Set([
  'set-content',
  'sc',
  'add-content',
  'ac',
  'out-file',
  'tee',
  'tee-object',
  'new-item',
  'ni',
  'copy-item',
  'ci',
  'cp',
  'xcopy',
  'robocopy',
  'move-item',
  'mi',
  'mv',
  'rename-item',
  'rni',
  'touch',
  'mkdir',
])

/** 长写法删除指令：出现在命令任意位置都算（误报率低）。 */
const DESTRUCTIVE_KEYWORD_RE =
  /\b(?:remove-item|clear-content|shutil\.rmtree|os\.remove|os\.unlink|unlinkSync|rmSync|rmdirSync|del(?:ete)?\s*\(\s*["'])/i

/** `git` 子命令里的破坏性动作。 */
const DESTRUCTIVE_GIT_RE = /\b(?:clean\b[^;|&]*-[a-z]*f|reset\s+--hard|checkout\s+--\s|push\s+(?:--force|-f)\b)/i

/** 输出重定向：`> file` / `>> file`（排除 `2>&1` 这类句柄复制）。 */
const WRITE_REDIRECT_RE = /(?:^|[^<>&])>{1,2}\s*[^>&\s]/

/** 常见「路径参数」的键名。 */
const PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target',
  'target_file',
  'targetFile',
  'file',
  'files',
  'paths',
  'source',
  'destination',
  'old_path',
  'new_path',
]

/**
 * `tools/pre-execute` 时算好的「调用小结」。
 *
 * 值形如 `{ summary, scope, at, size }`；`summary` 是风险分级的结果（等级 / 路径 / 套娃深度），
 * 只有几十字节。**不存原始参数**：命令可能有几百 KB，存原文既费内存，又会
 * 「把命令撑大就能躲开审查」——结论在 pre-execute 那一刻就算好，与体积无关。
 */
const toolArgsByCallId = new Map()
let toolArgsBytes = 0

/** 提问改写结果的缓存（请求内容 → 模型输出），避免同样的卡片重复花 token。 */
const rewriteCache = new Map()
let rewriteCacheBytes = 0

/** 从 Windows / POSIX 路径样式的文本里挑出候选路径。 */
const WINDOWS_PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|,;]+/g
const POSIX_PATH_RE = /(?:^|\s)((?:\.{1,2}\/|\/)[^\s"'<>|,;]+)/g

/** 估算一个 JSON 值占多少字节；估不出来（循环引用等）就当作超大。 */
function estimateBytes(value) {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text.length : 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * 取出一次调用的「会话作用域」。
 *
 * 缓存是进程级的，而用户可能同时开着好几个窗口干活。带上作用域之后，
 * 即使宿主复用了 callId，也不会把 A 窗口的参数拿去给 B 窗口的审批分级（不串台）。
 *
 * @param target - `tools/pre-execute` 的 exec 或 `approval/request` 的 request。
 * @returns 作用域字符串；拿不到就是空串（此时退回只按 callId 匹配）。
 */
function scopeOf(target) {
  if (target === null || typeof target !== 'object') return ''
  const agent = target.agent
  if (agent !== null && typeof agent === 'object') {
    if (typeof agent.id === 'string' && agent.id !== '') return agent.id
    if (typeof agent.sessionId === 'string' && agent.sessionId !== '') return agent.sessionId
  }
  for (const key of ['sessionId', 'scope']) {
    const value = target[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function dropCall(callId) {
  const entry = toolArgsByCallId.get(callId)
  if (entry === undefined) return
  toolArgsByCallId.delete(callId)
  toolArgsBytes -= entry.size
}

/** 清掉过期条目（顺手在写入前做，成本很低）。 */
function pruneCalls(now) {
  for (const [callId, entry] of toolArgsByCallId) {
    if (now - entry.at > CALL_TTL_MS) dropCall(callId)
  }
}

function evictOldestCall() {
  const oldest = toolArgsByCallId.keys().next().value
  if (oldest !== undefined) dropCall(oldest)
}

/**
 * 把一次工具调用压成**有界的小结**：风险等级 + 路径 + 套娃深度。
 *
 * 审批要的只是这个结论，不是原始参数。这样无论命令是 100 字节还是 500 KB，
 * 都只在 pre-execute 那一刻分析一次（分析本身有预算上限），缓存里只留几十字节。
 *
 * @param name - 工具名。
 * @param args - 该次调用的参数。
 * @returns `{ kind, paths, pathSource, nested, truncated }`。
 */
function summarizeCall(name, args) {
  const operation = classifyOperation(name, args)
  return {
    kind: operation.kind,
    paths: operation.paths,
    pathSource: operation.pathSource,
    nested: operation.nested ?? 0,
    truncated: operation.truncated === true,
  }
}

/**
 * 记住一次工具调用的结论（`tools/pre-execute` 时调用）。
 *
 * 三条硬上限：总条数、总字节数、TTL；任何一条超了都宁可丢线索，也不吃内存。
 *
 * @param exec - 工具执行对象（callId / name / arguments）。
 */
export function rememberToolCall(exec) {
  if (exec === null || typeof exec !== 'object') return
  const callId = exec.callId
  if (typeof callId !== 'string' || callId === '') return
  let summary
  try {
    summary = summarizeCall(exec.name, exec.arguments)
  } catch {
    // 分级本身出意外就按「看不出」记，绝不能因为这里抛错影响工具执行
    summary = { kind: 'neutral', paths: [], pathSource: 'none', nested: 0, truncated: false }
  }
  const size = estimateBytes(summary)
  const now = Date.now()
  pruneCalls(now)
  dropCall(callId)
  while (toolArgsByCallId.size >= MAX_CACHED_CALLS) evictOldestCall()
  while (toolArgsBytes + size > MAX_CACHED_ARG_BYTES && toolArgsByCallId.size > 0) evictOldestCall()
  toolArgsByCallId.set(callId, { summary, scope: scopeOf(exec), at: now, size })
  toolArgsBytes += size
}

/**
 * 忘掉一次工具调用（`tools/result` 时调用）。
 *
 * @param exec - 工具执行对象。
 */
export function forgetToolCall(exec) {
  if (exec === null || typeof exec !== 'object') return
  if (typeof exec.callId === 'string') dropCall(exec.callId)
}

/**
 * 取回某次审批对应调用的结论：过期不用、作用域对不上也不用。
 *
 * @param request - `approval/request` 的请求对象。
 * @returns 小结对象，或 `undefined`。
 */
function operationForRequest(request) {
  const callId = request?.callId
  if (callId === undefined) return undefined
  const entry = toolArgsByCallId.get(callId)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > CALL_TTL_MS) {
    dropCall(callId)
    return undefined
  }
  const requestScope = scopeOf(request)
  if (entry.scope !== '' && requestScope !== '' && entry.scope !== requestScope) return undefined
  return entry.summary
}

/** 从审批的审计原因里解析出沙箱提权信息。 */
export function parseSandboxReason(reason) {
  if (typeof reason !== 'string') return null
  const matched = SANDBOX_REASON_RE.exec(reason)
  if (!matched) return null
  const justification = matched[2].trim()
  if (justification.length === 0) return null
  return { mode: matched[1], justification }
}

function clip(text, max = MAX_ORIGINAL_CHARS) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

function looksLikePath(text) {
  if (typeof text !== 'string') return false
  const value = text.trim()
  if (value === '' || value.length > 500) return false
  return /[/\\]/.test(value) || /^[A-Za-z]:/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value)
}

function uniquePaths(paths) {
  const seen = new Set()
  const out = []
  for (const path of paths) {
    const value = String(path).trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= MAX_PATHS) break
  }
  return out
}

/** 从工具参数里收集路径。 */
export function collectArgsPaths(args) {
  const found = []
  if (args === null || typeof args !== 'object') return found
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string') {
      if (looksLikePath(value)) found.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && looksLikePath(item)) found.push(item)
    }
  }
  return uniquePaths(found)
}

/** 把命令按 `;` `|` `&&` 与换行粗分成若干条，逐条看第一个词。 */
function commandSegments(command) {
  return command
    .split(/[;&|\r\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
}

/** 取一条命令的第一个词（去掉 `&` 调用符、环境变量赋值、引号与路径前缀）。 */
function firstVerb(segment) {
  let cleaned = segment.replace(/^&\s*/, '')
  cleaned = cleaned.replace(/^(?:[A-Za-z_][\w]*=\S*\s+)+/, '')
  const matched = /^(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(cleaned)
  if (matched === null) return ''
  const raw = (matched[1] ?? matched[2] ?? matched[3] ?? '').replace(/^["']|["']$/g, '')
  return raw.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '')
}

/**
 * 判断一条命令是「删除类」「写入类」还是「看不出」。
 *
 * 规则：长写法的删除指令出现在任意位置都算删除；短别名只看每条命令的第一个词，
 * 避免把 `C:\rd\file.txt` 这类路径误判成 `rd`（删除）命令。
 *
 * @param command - 命令文本。
 * @returns `'destroy'` / `'write'` / `'neutral'`。
 */
export function classifyCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return 'neutral'
  if (DESTRUCTIVE_KEYWORD_RE.test(command)) return 'destroy'
  for (const segment of commandSegments(command)) {
    const verb = firstVerb(segment)
    if (verb === '') continue
    if (verb === 'git') {
      if (DESTRUCTIVE_GIT_RE.test(segment)) return 'destroy'
      continue
    }
    if (DESTRUCTIVE_VERBS.has(verb)) return 'destroy'
    if (WRITE_VERBS.has(verb)) return 'write'
  }
  if (WRITE_REDIRECT_RE.test(command)) return 'write'
  return 'neutral'
}

/* ── 套娃命令：展开 `bash -c` / `python -c` / `pwsh -Command` 等看真实命令 ── */

/** 单次分级的命令长度上限：超长的命令截断后再分析，避免在 MB 级字符串上做正则。 */
const MAX_COMMAND_CHARS = 20_000

/**
 * 包装器识别表。
 *
 * 每一项说明「谁会把一个字符串当脚本再执行一遍」。head 正则都很短、没有嵌套量词，
 * 不会被 ReDoS 拖死；引号 / 转义 / here-string 由手写扫描处理，不用贪心正则硬啃。
 */
const WRAPPER_HEADS = [
  { re: /(?:^|[\s;&|()])(?:ba|da|z|k|fi)?sh(?=\s)/gi, interpreter: 'shell' },
  { re: /(?:^|[\s;&|()])cmd(?:\.exe)?(?=\s)/gi, interpreter: 'cmd' },
  { re: /(?:^|[\s;&|()])(?:pwsh|powershell)(?:\.exe)?(?=\s)/gi, interpreter: 'powershell' },
  { re: /(?:^|[\s;&|()])python[0-9.]*(?:\.exe)?(?=\s)/gi, interpreter: 'python' },
  { re: /(?:^|[\s;&|()])node(?:\.exe)?(?=\s)/gi, interpreter: 'node' },
  { re: /(?:^|[\s;&|()])(?:perl|ruby)(?=\s)/gi, interpreter: 'perl' },
]

/**
 * 这些开关不接参数。扫描到它们要「直接看下一个」——
 * 否则 `-NoProfile` 会把 `-ExecutionPolicy` 当成自己的值吃掉，后面就找不到 -Command 了。
 */
const VALUELESS_FLAGS = new Set([
  'noprofile', 'nologo', 'noninteractive', 'noexit', 'nobanner', 'sta', 'mta',
  // 解释器里的单字母布尔开关（bash -x、cmd /d …）；`c` 不在这里——它是「执行代码」。
  'a', 'b', 'd', 'e', 'f', 'h', 'i', 'k', 'l', 'n', 'q', 's', 't', 'v', 'x',
])

/**
 * 判断「这个开关是不是执行代码的那个」，并说明载荷是明文还是 base64。
 *
 * @param interpreter - `shell` / `cmd` / `powershell` / `python` / `node` / `perl`。
 * @param flag - 命令里的开关，例如 `-c`、`/c`、`-Command`、`-EncodedCommand`。
 * @returns `'plain'` / `'encoded'` / `null`（不是执行开关）。
 */
function payloadKind(interpreter, flag) {
  const lower = flag.toLowerCase()
  if (interpreter === 'shell') return /^-[a-z]*c$/.test(lower) ? 'plain' : null
  if (interpreter === 'cmd') return /^\/[ck]$/.test(lower) ? 'plain' : null
  if (interpreter === 'powershell') {
    const bare = lower.replace(/^-+/, '')
    if (bare === '') return null
    // -EncodedCommand / -enc / -ec / -e …：都是它的前缀缩写
    if (bare.startsWith('e') && 'encodedcommand'.startsWith(bare)) return 'encoded'
    if (bare.startsWith('c') && 'command'.startsWith(bare)) return 'plain'
    return null
  }
  if (interpreter === 'python') return /^-c$/.test(lower) ? 'plain' : null
  if (interpreter === 'node') return /^(?:-e|--eval|-p|--print)$/.test(lower) ? 'plain' : null
  if (interpreter === 'perl') return /^-e$/.test(lower) ? 'plain' : null
  return null
}

/**
 * 从 `start` 开始读一个「脚本参数」。
 *
 * 支持：双引号（含 `\"` 转义、`""` 字面量）、单引号（含 `''` 字面量）、
 * PowerShell here-string（`@'…'@` / `@"…"@`）、裸参数（读到段尾）。
 *
 * @param text - 命令文本。
 * @param start - 参数的起始下标。
 * @returns `{ script, next }` 或 `null`。
 */
function readScriptArgument(text, start) {
  let index = start
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1
  if (index >= text.length) return null
  if (text.startsWith("@'", index) || text.startsWith('@"', index)) {
    const quote = text[index + 1]
    const terminator = `\n${quote}@`
    const end = text.indexOf(terminator, index + 2)
    if (end < 0) return { script: text.slice(index + 2), next: text.length }
    return { script: text.slice(index + 2, end), next: end + terminator.length }
  }
  const quote = text[index]
  if (quote === '"' || quote === "'") {
    let cursor = index + 1
    let script = ''
    while (cursor < text.length) {
      const char = text[cursor]
      if (char === '\\' && quote === '"' && cursor + 1 < text.length) {
        script += text[cursor + 1]
        cursor += 2
        continue
      }
      if (char === quote) {
        if (text[cursor + 1] === quote) {
          script += quote
          cursor += 2
          continue
        }
        return { script, next: cursor + 1 }
      }
      script += char
      cursor += 1
    }
    return { script, next: text.length }
  }
  let cursor = index
  let script = ''
  while (cursor < text.length && !/[;&|\r\n]/.test(text[cursor])) {
    script += text[cursor]
    cursor += 1
  }
  return { script, next: cursor }
}

/**
 * 找出这段命令里所有「会被再次执行」的子脚本。
 *
 * 会跳过包装器自己的其它开关（`-NoProfile`、`-ExecutionPolicy Bypass`、`-X utf8` 等），
 * 只在遇到真正的执行开关时取载荷。
 *
 * @param command - 命令文本。
 * @returns `[{ script, encoded }]`；`encoded` 为真表示载荷是 base64（UTF-16LE）。
 */
export function findNestedScripts(command) {
  if (typeof command !== 'string' || command === '') return []
  const found = []
  for (const head of WRAPPER_HEADS) {
    head.re.lastIndex = 0
    let matched
    while ((matched = head.re.exec(command)) !== null) {
      let cursor = matched.index + matched[0].length
      let guard = 0
      let consumed = false
      while (cursor < command.length && guard < 24) {
        guard += 1
        while (cursor < command.length && /\s/.test(command[cursor])) cursor += 1
        if (cursor >= command.length || !/^[-\/]/.test(command[cursor])) break
        const flagStart = cursor
        while (cursor < command.length && !/\s/.test(command[cursor])) cursor += 1
        const flag = command.slice(flagStart, cursor)
        const kind = payloadKind(head.interpreter, flag)
        if (kind === null) {
          // 不是执行开关：有值的开关（-ExecutionPolicy Bypass）连值一起跳过；
          // 无值开关（-NoProfile）只看下一个，别把后面的开关当成它的值。
          const bare = flag.toLowerCase().replace(/^[-\/]+/, '')
          if (!VALUELESS_FLAGS.has(bare)) {
            while (cursor < command.length && /\s/.test(command[cursor])) cursor += 1
            while (cursor < command.length && !/\s/.test(command[cursor])) cursor += 1
          }
          continue
        }
        const argument = readScriptArgument(command, cursor)
        if (argument === null) break
        if (argument.script.trim() !== '') found.push({ script: argument.script, encoded: kind === 'encoded' })
        head.re.lastIndex = argument.next
        consumed = true
        break
      }
      if (!consumed && head.re.lastIndex <= matched.index) head.re.lastIndex = matched.index + matched[0].length
    }
  }
  return found
}

/** `-EncodedCommand` 的载荷是 base64 编码的 UTF-16LE 脚本。 */
function decodeEncodedScript(encoded) {
  try {
    return Buffer.from(encoded.trim(), 'base64').toString('utf16le')
  } catch {
    return ''
  }
}

/**
 * 深度分级：先按外层命令判，再把套娃里的子脚本逐个展开重判，取最严重的结论。
 *
 * 三重预算保证它一定会停：
 *  - `MAX_NEST_DEPTH`：最多展开几层（防无限套娃）；
 *  - `MAX_NEST_CHARS`：本次分级总共能处理多少字符；
 *  - `MAX_NEST_OPENINGS`：最多展开几个子脚本（防「一层里塞几百个 bash -c」）。
 * 任一预算耗尽就收工，并把 `truncated` 标出来，文案里如实告诉用户「没看完」。
 *
 * @param command - 命令文本。
 * @returns `{ kind, paths, depth, truncated }`。
 */
export function classifyCommandDeep(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { kind: 'neutral', paths: [], depth: 0, truncated: false }
  }
  const clipped = command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command
  const budget = { chars: MAX_NEST_CHARS, openings: MAX_NEST_OPENINGS }
  const paths = []
  let kind = 'neutral'
  let depth = 0
  let truncated = clipped.length !== command.length

  const visit = (text, level) => {
    const verdict = classifyCommand(text)
    if (verdict === 'destroy') kind = 'destroy'
    else if (verdict === 'write' && kind !== 'destroy') kind = 'write'
    for (const path of pathsFromCommand(text)) paths.push(path)

    if (level >= MAX_NEST_DEPTH) {
      if (findNestedScripts(text).length > 0) truncated = true
      return
    }
    for (const nested of findNestedScripts(text)) {
      if (budget.openings <= 0 || budget.chars <= 0) {
        truncated = true
        return
      }
      budget.openings -= 1
      let script = nested.encoded ? decodeEncodedScript(nested.script) : nested.script
      if (script === '') continue
      if (script.length > budget.chars) {
        script = script.slice(0, budget.chars)
        truncated = true
      }
      budget.chars -= script.length
      depth = Math.max(depth, level + 1)
      visit(script, level + 1)
      if (budget.chars <= 0) {
        truncated = true
        return
      }
    }
  }

  visit(clipped, 0)
  return { kind, paths: uniquePaths(paths), depth, truncated }
}

/** 路径开头的形态：盘符、分隔符或相对前缀。 */
const LEADING_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])/
const QUOTED_TEXT_RE = /"([^"]{2,300})"|'([^']{2,300})'/g
const REDIRECT_TARGET_RE = /(?:^|[^<>&])>{1,2}\s*([^\s;&|]+)/g

/**
 * 字面路径判定：排除变量、子表达式、花括号插值等「长得像路径的表达式」，
 * 例如 `$(Test-Path .\x)`、`$env:USERPROFILE\.dsh\a.log`。
 *
 * @param value - 候选文本。
 * @returns 是否像一条字面路径。
 */
function isLiteralPath(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text === '' || text.length > 500) return false
  if (/[=$`{}]/.test(text)) return false
  return looksLikePath(text)
}

/**
 * 引号内的字面路径：以路径前缀开头（可含空格），或整体不含空白（如 `"log.txt"`）。
 * 用来挡掉 `"exists=$(Test-Path .\x)"` 这类被引号包住的表达式。
 *
 * @param value - 引号内文本。
 * @returns 是否接受为路径。
 */
function isQuotedPath(value) {
  if (!isLiteralPath(value)) return false
  const text = value.trim()
  return LEADING_PATH_RE.test(text) || !/\s/.test(text)
}

/**
 * 这一段命令是否真的会改动文件；只有会改动的段才值得提取路径。
 * `Set-Location C:\ws; Set-Content .\x.txt` 里第一段不改文件，因此不会把工作区路径算进去。
 *
 * @param segment - 一段命令。
 * @returns 是否从这一段提取路径。
 */
function segmentChangesPaths(segment) {
  if (DESTRUCTIVE_KEYWORD_RE.test(segment)) return true
  const verb = firstVerb(segment)
  if (verb === 'git') return DESTRUCTIVE_GIT_RE.test(segment)
  if (DESTRUCTIVE_VERBS.has(verb) || WRITE_VERBS.has(verb)) return true
  return WRITE_REDIRECT_RE.test(segment)
}

/**
 * 从命令文本里尽量提取会被写入 / 删除的路径（启发式，可能不全）。
 *
 * 只从「真的会改动文件的命令段」里取，且只认字面路径：
 * - `Set-Location C:\ws; Set-Content .\x.txt` → 只给 `.\x.txt`；
 * - `Remove-Item .\x; "exists=$(Test-Path .\x)"` → 只给 `.\x`，子表达式不会混进来。
 *
 * @param command - 命令文本。
 * @returns 去重后的路径列表。
 */
export function pathsFromCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return []
  const found = []
  for (const segment of commandSegments(command)) {
    if (!segmentChangesPaths(segment)) continue
    for (const matched of segment.matchAll(QUOTED_TEXT_RE)) {
      const value = matched[1] ?? matched[2] ?? ''
      if (isQuotedPath(value)) found.push(value)
    }
    // 引号内容已经单独处理过，这里只看裸 token，避免重复与误收。
    const bare = segment.replace(QUOTED_TEXT_RE, ' ')
    for (const token of bare.split(/[\s,]+/)) {
      if (token === '' || token.startsWith('-') || token.startsWith('$')) continue
      if (isLiteralPath(token)) found.push(token)
    }
    for (const matched of segment.matchAll(REDIRECT_TARGET_RE)) {
      if (isLiteralPath(matched[1])) found.push(matched[1])
    }
  }
  return uniquePaths(found)
}

/**
 * 从一段普通文字（例如审批说明、理由）里提取路径。
 * 用于拿不到工具参数时的兜底：宁可给出「可能不全」的线索，也好过只说「不知道」。
 *
 * @param text - 任意文字。
 * @returns 去重后的路径列表。
 */
export function pathsFromText(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const found = []
  for (const matched of text.matchAll(WINDOWS_PATH_RE)) found.push(matched[0])
  for (const matched of text.matchAll(POSIX_PATH_RE)) found.push(matched[1])
  return uniquePaths(found.filter((value) => looksLikePath(value)))
}

/**
 * 判断一次操作属于读取、写入、删除，还是其它。
 *
 * @param toolName - 工具名。
 * @param args - 该次调用的参数（可能拿不到）。
 * @returns `{ kind: 'read' | 'write' | 'destroy' | 'neutral', paths, pathSource }`。
 *   `pathSource` 说明路径从哪来：`args`（参数）、`command`（命令文本，启发式）或 `none`。
 */
export function classifyOperation(toolName, args) {
  const name = toolName === undefined || toolName === null ? '' : String(toolName).toLowerCase()
  if (READ_TOOLS.has(name)) {
    return { kind: 'read', paths: collectArgsPaths(args), pathSource: 'args' }
  }
  if (DELETE_TOOLS.has(name)) {
    return { kind: 'destroy', paths: collectArgsPaths(args), pathSource: 'args' }
  }
  if (WRITE_TOOLS.has(name)) {
    return { kind: 'write', paths: collectArgsPaths(args), pathSource: 'args' }
  }
  if (SHELL_TOOLS.has(name)) {
    const command = args !== null && typeof args === 'object' && typeof args.command === 'string' ? args.command : ''
    const analysis = classifyCommandDeep(command)
    const extra = { nested: analysis.depth, truncated: analysis.truncated }
    if (analysis.kind === 'destroy' || analysis.kind === 'write') {
      return { kind: analysis.kind, paths: analysis.paths, pathSource: 'command', ...extra }
    }
    return { kind: 'neutral', paths: [], pathSource: 'none', ...extra }
  }
  return { kind: 'neutral', paths: [], pathSource: 'none' }
}

function formatPaths(paths, pathSource, locale) {
  if (paths.length === 0) {
    return t(locale, pathSource === 'command' ? 'paths_command_none' : 'paths_none')
  }
  const joined = paths.join(locale === 'zh' ? '、' : ', ')
  if (pathSource === 'command') return t(locale, 'paths_command', { paths: joined })
  if (pathSource === 'reason') return t(locale, 'paths_reason', { paths: joined })
  return joined
}

/** 审批请求里原本要展示给用户的文字（字符串或本地化映射）。 */
export function originalDisplayText(request, locale = 'zh') {
  const display = request?.displayReason
  if (typeof display === 'string') return clip(display)
  if (display && typeof display === 'object') {
    return clip(display[locale] ?? display.en ?? Object.values(display)[0] ?? '')
  }
  return clip(request?.reason)
}

function modeGloss(locale, mode) {
  const gloss = t(locale, `mode.${mode}`)
  return gloss !== '' ? gloss : t(locale, 'mode.fallback')
}

function compose(locale, request, sandbox, operation, reasonText) {
  const tool = typeof request?.toolName === 'string' && request.toolName.trim() !== '' ? request.toolName : 'unknown tool'
  const suffix = sandbox === null ? '_plain' : '_escalated'
  const vars = {
    tool,
    mode: sandbox === null ? '' : sandbox.mode,
    gloss: sandbox === null ? '' : modeGloss(locale, sandbox.mode),
    paths: formatPaths(operation.paths, operation.pathSource, locale),
    reason: reasonText === '' ? '' : t(locale, 'reason', { text: reasonText }),
  }

  let text
  if (operation.kind === 'read') text = t(locale, `read${suffix}`, vars)
  else if (operation.kind === 'destroy') text = t(locale, `destroy${suffix}`, vars)
  else if (operation.kind === 'write') text = t(locale, `write${suffix}`, vars)
  else if (sandbox !== null) text = t(locale, 'command', vars)
  else {
    const original = originalDisplayText(request, locale)
    text = t(locale, 'neutral', {
      ...vars,
      original: original === '' ? '' : t(locale, 'original', { text: original }),
    })
  }
  // 套娃命令：把「看没看完」如实告诉用户——看了几层就说看了，预算耗尽就说不完整。
  if (operation.nested > 0) text += t(locale, 'nested')
  if (operation.truncated) text += t(locale, 'nested_truncated')
  return text
}

/**
 * 生成审批面板要显示的本地化文案（按 DSH 的 LocalizedText 形状：小写语言 id、必须带 en）。
 *
 * 分级规则：
 * - 读取类工具 → 🟢（只读，不会动文件）；
 * - 写入/改动（写入类工具、只写不删的命令、输出重定向）→ ⚠️ 会写入文件；
 * - 删除/覆盖（删除类工具、删除命令、`git clean`、`git reset --hard`、脚本内删文件）→ 🔴 高危；
 * - 其它（含不涉及删除的命令）→ ⚙️ 中性提示。
 *
 * @param request - `approval/request` 的请求对象（toolName / callId / reason / displayReason）。
 * @returns 至少含 `en` 的文案映射。
 */
export function approvalDisplayText(request) {
  const sandbox = parseSandboxReason(request?.reason)
  // pre-execute 那一刻算好的结论优先；拿不到就现算（参数缺失时按「看不出」处理）。
  let operation = operationForRequest(request) ?? classifyOperation(request?.toolName, undefined)
  const reasonText = sandbox !== null
    ? clip(sandbox.justification)
    : originalDisplayText(request, 'zh')

  // 拿不到工具参数时的兜底：从审批说明里再找一次路径。
  if (operation.paths.length === 0 && reasonText !== '') {
    const fromReason = pathsFromText(reasonText)
    if (fromReason.length > 0) operation = { ...operation, paths: fromReason, pathSource: 'reason' }
  }

  return {
    zh: compose('zh', request, sandbox, operation, reasonText),
    en: compose('en', request, sandbox, operation, reasonText),
  }
}

/**
 * 就地改写一个审批请求的展示文案。
 *
 * @param request - `approval/request` 的请求对象。
 * @returns 是否改写了（不可写或已是最新时为 false）。
 */
export function decorateApprovalRequest(request) {
  if (request === null || typeof request !== 'object') return false
  const text = approvalDisplayText(request)
  if (request.displayReason === text) return false
  request.displayReason = text
  return true
}

/** 只挑出需要模型改写的字段（去掉 intent / detail 等，避免把大块计划塞进提示词）。 */
export function rewritePayload(questions) {
  return questions.map((question) => {
    const payload = {
      id: question.id,
      question: question.question,
    }
    if (typeof question.header === 'string') payload.header = question.header
    if (Array.isArray(question.options) && question.options.length > 0) {
      payload.options = question.options.map((option) => {
        const item = { label: option.label }
        if (typeof option.description === 'string') item.description = option.description
        return item
      })
    }
    return payload
  })
}

/** 克隆一条问题；结构化克隆失败时退回 JSON 克隆（问题都是纯 JSON 数据）。 */
function cloneQuestion(question) {
  try {
    return structuredClone(question)
  } catch {
    return JSON.parse(JSON.stringify(question))
  }
}

/**
 * 判断一个问题是否有需要改写的非中文文字。
 *
 * 只统计真正会展示给用户的文字：question / header / option.description。
 * label 是回答词汇、从不改写，因此不参与判断；已是中文的问题会整条跳过，
 * 省掉一次模型调用。
 *
 * @param question - 单个问题。
 * @returns 是否需要交给模型改写。
 */
export function needsRewrite(question) {
  if (question === null || typeof question !== 'object') return false
  const texts = [question.question, question.header]
  if (Array.isArray(question.options)) {
    for (const option of question.options) {
      if (option !== null && typeof option === 'object') texts.push(option.description)
    }
  }
  return texts.some((text) => typeof text === 'string' && text.trim() !== '' && !HAS_CJK.test(text))
}

/**
 * 校验并应用模型返回的改写结果。
 *
 * 校验不通过就一条都不写（整体失败），宁可显示原话也不显示错话。
 *
 * @param questions - 原始问题数组（会被就地改写）。
 * @param rewritten - 模型解析出的数组。
 * @returns 是否应用成功。
 */
export function applyQuestionRewrites(questions, rewritten) {
  if (!Array.isArray(questions) || !Array.isArray(rewritten)) return false
  if (questions.length === 0 || rewritten.length !== questions.length) return false

  for (let index = 0; index < questions.length; index += 1) {
    const original = questions[index]
    const next = rewritten[index]
    if (original === null || typeof original !== 'object') return false
    if (next === null || typeof next !== 'object') return false
    if (next.id !== original.id) return false
    if (typeof next.question !== 'string' || next.question.trim() === '') return false
    if ((original.header === undefined) !== (next.header === undefined)) return false
    if (original.header !== undefined) {
      if (typeof next.header !== 'string' || next.header.trim() === '') return false
    }
    const originalOptions = Array.isArray(original.options) ? original.options : []
    const nextOptions = Array.isArray(next.options) ? next.options : []
    if (originalOptions.length !== nextOptions.length) return false
    for (let optionIndex = 0; optionIndex < originalOptions.length; optionIndex += 1) {
      const option = originalOptions[optionIndex]
      const rewrittenOption = nextOptions[optionIndex]
      if (rewrittenOption === null || typeof rewrittenOption !== 'object') return false
      // label 是回答词汇：必须原样保留。
      if (rewrittenOption.label !== option.label) return false
      if (option.description !== undefined) {
        if (typeof rewrittenOption.description !== 'string' || rewrittenOption.description.trim() === '') return false
      } else if (rewrittenOption.description !== undefined) {
        // 原选项没有描述：只允许给「非中文 label」补一句解释，避免给中文选项凭空加信息。
        if (HAS_CJK.test(String(option.label ?? ''))) return false
        if (typeof rewrittenOption.description !== 'string' || rewrittenOption.description.trim() === '') return false
      }
    }
  }

  for (let index = 0; index < questions.length; index += 1) {
    const original = questions[index]
    const next = rewritten[index]
    original.question = next.question
    if (original.header !== undefined) original.header = next.header
    if (Array.isArray(original.options)) {
      for (let optionIndex = 0; optionIndex < original.options.length; optionIndex += 1) {
        const option = original.options[optionIndex]
        const rewrittenOption = next.options[optionIndex]
        if (typeof rewrittenOption.description === 'string') option.description = rewrittenOption.description
      }
    }
  }
  return true
}

/** 构造改写提示词。 */
export function buildRewritePrompt(payload) {
  return [
    '你在帮一个普通用户看懂「另一个 AI 助理向你提出的问题」。',
    '把下面 JSON 里的文字改写成通俗、直白的简体中文，让没有技术背景的人一眼看懂。',
    '',
    '铁律（违反任何一条都算失败）：',
    '1. 只改措辞，不改任何事实、条件、风险、推荐倾向或默认选择；不新增、不删除任何主张。',
    '1.1 输入里已经是中文的字段保持原意，不要为了改写而改变说法；只把非中文或术语堆砌的部分改成通俗中文。',
    '2. 以下内容必须原样保留：每个问题的 id、问题的数量与顺序、每个选项的 label、选项的数量与顺序。',
    '3. 只改写这些字段：question、header、options[].description；不改 label 一字。',
    '3.1 options[].description 必须让读者明白这个选项 label 是什么意思：label 含非中文术语时补一句中文解释；',
    '    原描述的事实必须保留。原本没有 description 的选项，也可以补一句只解释 label 的话（仅限非中文 label）。',
    '4. 输出必须是与输入一一对应的 JSON 数组，形如：',
    '   [{"id":"...","question":"...","header":"...","options":[{"label":"原样","description":"..."}]}]',
    '5. 只输出 JSON，不要解释，不要代码块围栏。',
    '',
    '输入 JSON：',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

/** 从模型输出里解析 JSON 数组（容忍代码块围栏）。 */
export function parseRewrittenArray(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function pickTarget(llm, agent) {
  const options = (agent && agent.options) || {}
  let provider = typeof options.provider === 'string' ? options.provider : ''
  const model = typeof options.model === 'string' ? options.model : ''
  if (provider === '') {
    try {
      const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
      const first = Array.isArray(providers) ? providers[0] : undefined
      if (typeof first === 'string') provider = first
      else if (first && typeof first === 'object') provider = first.provider || first.name || ''
    } catch {
      provider = ''
    }
  }
  return { provider, model: model || 'deepseek-flash' }
}

function combineSignals(requestSignal, timeoutMs) {
  const signals = []
  if (requestSignal !== undefined) signals.push(requestSignal)
  if (typeof AbortSignal.timeout === 'function') signals.push(AbortSignal.timeout(timeoutMs))
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  return signals[0]
}

function forgetRewrite(key) {
  const entry = rewriteCache.get(key)
  if (entry === undefined) return
  rewriteCache.delete(key)
  rewriteCacheBytes -= entry.size
}

/**
 * 缓存改写结果：同样的卡片内容不重复花 token。
 * 带 TTL 与总字节上限——缓存本身不能变成内存泄漏。
 */
function rememberRewrite(key, parsed) {
  const size = estimateBytes(parsed)
  if (!(size <= MAX_CACHED_REWRITE_BYTES)) return
  forgetRewrite(key)
  while (rewriteCache.size >= MAX_CACHED_REWRITES) {
    const oldest = rewriteCache.keys().next().value
    if (oldest === undefined) break
    forgetRewrite(oldest)
  }
  while (rewriteCacheBytes + size > MAX_CACHED_REWRITE_BYTES && rewriteCache.size > 0) {
    const oldest = rewriteCache.keys().next().value
    if (oldest === undefined) break
    forgetRewrite(oldest)
  }
  rewriteCache.set(key, { parsed, at: Date.now(), size })
  rewriteCacheBytes += size
}

/** 命中就用，过期就丢。 */
function recallRewrite(key) {
  const entry = rewriteCache.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > REWRITE_TTL_MS) {
    forgetRewrite(key)
    return undefined
  }
  return entry.parsed
}

/**
 * 用当前模型把提问改写得更通俗。失败 / 超时 / 校验不过时保持原样。
 * 只改写「含非中文文字」的问题；已全是中文的问题整条跳过，省掉一次模型调用。
 * 相同内容的卡片命中缓存，不再调用模型。
 *
 * @param ctx - 插件上下文（需要能取到 `llm` 服务）。
 * @param request - `user-questions/request` 的请求对象。
 * @returns 是否成功改写。
 */
export async function rewriteQuestions(ctx, request) {
  try {
    return await rewriteQuestionsInner(ctx, request)
  } catch (error) {
    debugLog(`rewrite threw: ${error && error.message ? error.message : String(error)}`)
    return false
  }
}

async function rewriteQuestionsInner(ctx, request) {
  if (request === null || typeof request !== 'object') return false
  const questions = request.questions
  if (!Array.isArray(questions) || questions.length === 0) return false
  // Web 审批/提问桥要求请求直接携带 agent；没有 agent 的请求不会到浏览器，不用花 token。
  if (request.agent === undefined || request.agent === null) {
    debugLog('rewrite skip: request has no agent')
    return false
  }

  // 工具参数在 dsh-tools 里被 deepFreeze 过，问题对象是只读的：
  // 不能就地改，只能克隆一份、改克隆，再用克隆数组替换 request.questions
  // （request 本身是 ask() 里新建的对象，可写）。
  const clones = questions.map(cloneQuestion)
  const targets = clones.filter(needsRewrite)
  if (targets.length === 0) {
    debugLog(`rewrite skip: all ${questions.length} question(s) already Chinese`)
    return false
  }

  const payload = rewritePayload(targets)
  const cacheKey = JSON.stringify(payload)

  const cached = recallRewrite(cacheKey)
  if (cached !== undefined) {
    if (!applyQuestionRewrites(targets, cached)) {
      forgetRewrite(cacheKey)
    } else {
      try {
        request.questions = clones
        debugLog(`rewrite applied from cache: ${targets.length}/${questions.length} question(s)`)
        return true
      } catch (error) {
        debugLog(`rewrite cannot replace request.questions: ${error && error.message ? error.message : String(error)}`)
        return false
      }
    }
  }

  let llm
  try {
    llm = typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm
  } catch (error) {
    debugLog(`rewrite skip: llm access threw: ${error && error.message ? error.message : String(error)}`)
    return false
  }
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    debugLog('rewrite skip: llm service unavailable')
    return false
  }

  let target
  try {
    target = pickTarget(llm, request.agent)
  } catch (error) {
    debugLog(`rewrite skip: agent options threw: ${error && error.message ? error.message : String(error)}`)
    return false
  }
  if (target.provider === '' || target.model === '') {
    debugLog(`rewrite skip: no model target provider=${target.provider || '-'} model=${target.model || '-'}`)
    return false
  }

  let collected = ''
  try {
    const stream = llm.stream({
      provider: target.provider,
      model: target.model,
      maxTokens: REWRITE_MAX_TOKENS,
      reasoningEffort: 'off',
      signal: combineSignals(request.signal, REWRITE_TIMEOUT_MS),
      messages: [{ role: 'user', content: [{ type: 'text', text: buildRewritePrompt(payload) }] }],
    })
    for await (const chunk of stream) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        collected += chunk.text
      } else if (chunk.type === 'finish') {
        const kind = chunk.reason && chunk.reason.kind
        if (kind === 'error' || kind === 'aborted') {
          debugLog(`rewrite stream finished: ${kind} provider=${target.provider} model=${target.model}`)
          return false
        }
      }
    }
  } catch (error) {
    debugLog(`rewrite stream threw: ${error && error.message ? error.message : String(error)}`)
    return false
  }

  const parsed = parseRewrittenArray(collected)
  if (parsed === null) {
    debugLog(`rewrite output was not a JSON array (len=${collected.length})`)
    return false
  }
  if (!applyQuestionRewrites(targets, parsed)) {
    // 不记正文：模型输出里含问题原文，日志只留长度与结构，够定位就行。
    debugLog(`rewrite output failed validation (len=${collected.length} items=${Array.isArray(parsed) ? parsed.length : 'n/a'})`)
    return false
  }
  try {
    request.questions = clones
  } catch (error) {
    debugLog(`rewrite cannot replace request.questions: ${error && error.message ? error.message : String(error)}`)
    return false
  }
  rememberRewrite(cacheKey, parsed)
  debugLog(`rewrite applied: ${targets.length}/${questions.length} question(s)`)
  return true
}

/**
 * 插件入口：在浏览器桥之前拦截审批 / 提问，并缓存工具参数用于风险分级。
 *
 * @param ctx - Cordis 插件上下文。
 */
export function apply(ctx) {
  debugLog(`activated ${BUILD}`)

  ctx.on(
    'tools/pre-execute',
    (exec, next) => {
      try {
        rememberToolCall(exec)
      } catch {
        // 缓存失败不影响工具执行
      }
      return next()
    },
    { prepend: true, global: true },
  )

  ctx.on(
    'tools/result',
    (exec) => {
      try {
        forgetToolCall(exec)
      } catch {
        // 清理失败无影响
      }
    },
    { global: true },
  )

  ctx.on(
    'approval/request',
    (request, next) => {
      try {
        const decorated = decorateApprovalRequest(request)
        if (decorated) {
          const sandbox = parseSandboxReason(request.reason)
          const operation = operationForRequest(request) ?? classifyOperation(request.toolName, undefined)
          debugLog(
            `approval decorated tool=${request.toolName ?? '?'}`
              + ` kind=${operation.kind}${sandbox ? ` sandbox:${sandbox.mode}` : ''}`
              + ` paths=${operation.paths.length} source=${operation.pathSource}`
              + `${operation.nested > 0 ? ` nested=${operation.nested}` : ''}`
              + `${operation.truncated ? ' truncated' : ''}`,
          )
        }
      } catch {
        // fail-open：展示文案改不了就保持原样
      }
      return next()
    },
    { prepend: true, global: true },
  )

  ctx.on(
    'user-questions/request',
    async (request, next) => {
      let rewritten = false
      try {
        rewritten = await rewriteQuestions(ctx, request)
      } catch (error) {
        debugLog(`questions listener threw: ${error && error.message ? error.message : String(error)}`)
      }
      const count = Array.isArray(request?.questions) ? request.questions.length : 0
      if (count > 0) debugLog(`questions ${rewritten ? 'rewritten' : 'kept-original'} count=${count}`)
      return next()
    },
    { prepend: true, global: true },
  )
}
