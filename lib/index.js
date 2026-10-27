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
 *
 * 文案全部放在 `locale/*.json`，代码只负责组装；缺 key 时回落到英文。
 * 所有路径都 fail-open：任何异常都放行原始内容，绝不因为本插件卡住或拦下操作。
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
 * 一行式诊断日志，便于确认插件真的挂载、真的改到了文案。
 * 只记工具名 / 模式 / 结果 / 路径条数，不记命令正文与问题正文。失败静默。
 *
 * @param line - 日志行。
 */
function debugLog(line) {
  try {
    appendFileSync(join(homedir(), '.dsh', 'dsh-plain-approvals.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // 日志失败不影响插件行为
  }
}

const SANDBOX_REASON_RE = /^escalate sandbox to ([a-z-]+):([\s\S]*)$/
const MAX_ORIGINAL_CHARS = 600
const MAX_PATHS = 8
const MAX_CACHED_CALLS = 256
const MAX_CACHED_REWRITES = 64
const REWRITE_TIMEOUT_MS = 15_000
const REWRITE_MAX_TOKENS = 2000

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

/** tools/pre-execute 捕获的本次调用参数（callId → arguments）。 */
const toolArgsByCallId = new Map()

/** 提问改写结果的缓存（请求内容 → 模型输出），避免同样的卡片重复花 token。 */
const rewriteCache = new Map()

/** 从 Windows / POSIX 路径样式的文本里挑出候选路径。 */
const WINDOWS_PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|,;]+/g
const POSIX_PATH_RE = /(?:^|\s)((?:\.{1,2}\/|\/)[^\s"'<>|,;]+)/g

/**
 * 记住一次工具调用的参数（`tools/pre-execute` 时调用）。
 *
 * @param exec - 工具执行对象（callId / name / arguments）。
 */
export function rememberToolCall(exec) {
  if (exec === null || typeof exec !== 'object') return
  const callId = exec.callId
  if (typeof callId !== 'string' || callId === '') return
  if (toolArgsByCallId.size >= MAX_CACHED_CALLS) {
    const oldest = toolArgsByCallId.keys().next().value
    if (oldest !== undefined) toolArgsByCallId.delete(oldest)
  }
  toolArgsByCallId.set(callId, exec.arguments)
}

/**
 * 忘掉一次工具调用（`tools/result` 时调用）。
 *
 * @param exec - 工具执行对象。
 */
export function forgetToolCall(exec) {
  if (exec === null || typeof exec !== 'object') return
  if (typeof exec.callId === 'string') toolArgsByCallId.delete(exec.callId)
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

/** 从命令文本里尽量提取被删除 / 覆盖的路径（启发式，可能不全）。 */
export function pathsFromCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return []
  const found = []
  const verbRe = /(?:remove-item|ri|rm|del|erase|rmdir|rd|shred|sdelete|deltree|unlink|truncate|clear-content|clc|set-content|sc|add-content|ac|out-file|copy-item|ci|cp|xcopy|robocopy|new-item|ni|move-item|mi|mv|rename-item|rni|tee|touch|mkdir)\s+(?:-[A-Za-z]+\s+)*("[^"]+"|'[^']+'|[^\s;|&]+)/gi
  for (const matched of command.matchAll(verbRe)) found.push(matched[1].replace(/^["']|["']$/g, ''))
  const quotedRe = /"([^"]{2,300})"|'([^']{2,300})'/g
  for (const matched of command.matchAll(quotedRe)) found.push(matched[1] ?? matched[2] ?? '')
  const redirectRe = /(?:^|[^<>&])>{1,2}\s*([^\s;&|]+)/g
  for (const matched of command.matchAll(redirectRe)) found.push(matched[1])
  for (const matched of command.matchAll(WINDOWS_PATH_RE)) found.push(matched[0])
  return uniquePaths(found.filter((value) => looksLikePath(value)))
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
    const verdict = classifyCommand(command)
    if (verdict === 'destroy') return { kind: 'destroy', paths: pathsFromCommand(command), pathSource: 'command' }
    if (verdict === 'write') return { kind: 'write', paths: pathsFromCommand(command), pathSource: 'command' }
    return { kind: 'neutral', paths: [], pathSource: 'none' }
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

  if (operation.kind === 'read') return t(locale, `read${suffix}`, vars)
  if (operation.kind === 'destroy') return t(locale, `destroy${suffix}`, vars)
  if (operation.kind === 'write') return t(locale, `write${suffix}`, vars)
  if (sandbox !== null) return t(locale, 'command', vars)
  const original = originalDisplayText(request, locale)
  return t(locale, 'neutral', {
    ...vars,
    original: original === '' ? '' : t(locale, 'original', { text: original }),
  })
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
  const args = request?.callId !== undefined && toolArgsByCallId.has(request.callId)
    ? toolArgsByCallId.get(request.callId)
    : undefined
  let operation = classifyOperation(request?.toolName, args)
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

/** 缓存改写结果：同样的卡片内容不重复花 token。 */
function rememberRewrite(key, parsed) {
  if (rewriteCache.size >= MAX_CACHED_REWRITES) {
    const oldest = rewriteCache.keys().next().value
    if (oldest !== undefined) rewriteCache.delete(oldest)
  }
  rewriteCache.set(key, parsed)
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

  const cached = rewriteCache.get(cacheKey)
  if (cached !== undefined) {
    if (!applyQuestionRewrites(targets, cached)) {
      rewriteCache.delete(cacheKey)
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
    debugLog(`rewrite output failed validation (raw=${collected.slice(0, 160).replace(/\s+/g, ' ')})`)
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
          const args = request.callId !== undefined ? toolArgsByCallId.get(request.callId) : undefined
          const operation = classifyOperation(request.toolName, args)
          debugLog(
            `approval decorated tool=${request.toolName ?? '?'}`
              + ` kind=${operation.kind}${sandbox ? ` sandbox:${sandbox.mode}` : ''}`
              + ` paths=${operation.paths.length} source=${operation.pathSource}`,
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
