import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  apply,
  applyQuestionRewrites,
  approvalDisplayText,
  buildRewritePrompt,
  cacheStats,
  classifyCommand,
  classifyCommandDeep,
  classifyOperation,
  collectArgsPaths,
  debugLog,
  decorateApprovalRequest,
  findNestedScripts,
  flushLog,
  forgetToolCall,
  needsRewrite,
  parseRewrittenArray,
  parseSandboxReason,
  pathsFromCommand,
  pathsFromText,
  rememberToolCall,
  rewriteQuestions,
} from '../lib/index.js'

const readLocale = (id) => JSON.parse(readFileSync(new URL(`../locale/${id}.json`, import.meta.url), 'utf8'))
const ZH = readLocale('zh')
const EN = readLocale('en')

const sandboxRequest = (callId, mode = 'danger-full-access', justify = '需要读取工作区外的驱动版本信息') => ({
  toolName: 'pwsh',
  ...(callId === undefined ? {} : { callId }),
  reason: `escalate sandbox to ${mode}: ${justify}`,
})

test('parseSandboxReason: 解析模式与理由', () => {
  const parsed = parseSandboxReason('escalate sandbox to workspace-write: 需要写入 C:/temp')
  assert.deepEqual(parsed, { mode: 'workspace-write', justification: '需要写入 C:/temp' })
  assert.equal(parseSandboxReason('escalate sandbox to danger-full-access:'), null)
  assert.equal(parseSandboxReason('the user asked'), null)
  assert.equal(parseSandboxReason(undefined), null)
})

test('classifyOperation: 读取 / 写入 / 删除 / 其它', () => {
  const read = classifyOperation('read', { file_path: 'C:/a.txt' })
  assert.equal(read.kind, 'read')
  assert.deepEqual(read.paths, ['C:/a.txt'])
  assert.equal(read.pathSource, 'args')

  const write = classifyOperation('write', { file_path: 'C:/a.txt', content: 'x' })
  assert.equal(write.kind, 'write')
  assert.deepEqual(write.paths, ['C:/a.txt'])

  assert.equal(classifyOperation('edit', { file_path: 'C:/a.txt' }).kind, 'write')
  assert.equal(classifyOperation('delete_file', { file_path: 'C:/a.txt' }).kind, 'destroy')
  assert.equal(classifyOperation('some-tool', { anything: 1 }).kind, 'neutral')
})

test('classifyCommand: 删除类命令（含原先漏报的写法）', () => {
  for (const command of [
    'Remove-Item C:/tmp/x.txt -Force',
    'rm -rf ./build',
    'del /q C:/tmp/a.txt',
    'ri -Recurse C:/tmp/dir',
    'rd /s /q C:/tmp/dir',
    'git clean -fdx',
    'git reset --hard HEAD~1',
    'git checkout -- src/app.ts',
    'python -c "import shutil; shutil.rmtree(\'build\')"',
    'python -c "import os; os.remove(\'a.txt\')"',
  ]) {
    const verdict = classifyCommand(command)
    assert.equal(verdict, 'destroy', `expected destroy: ${command}`)
  }
})

test('classifyCommand: 写入类命令（原先被误判为高危）', () => {
  for (const command of [
    'Get-Date > log.txt',
    'Set-Content -Path C:/a.txt -Value x',
    "Add-Content C:/a.txt 'x'",
    'Out-File -FilePath C:/a.txt',
    'Copy-Item C:/a.txt C:/b.txt',
    'New-Item -ItemType Directory C:/tmp/new',
    'Get-ChildItem | Tee-Object C:/a.txt',
  ]) {
    assert.equal(classifyCommand(command), 'write', `expected write: ${command}`)
  }
})

test('classifyCommand: 不误报路径里的短别名与句柄重定向', () => {
  assert.equal(classifyCommand('Get-ChildItem C:\\rd\\notes.txt'), 'neutral')
  assert.equal(classifyCommand('Get-Date 2>&1'), 'neutral')
  assert.equal(classifyCommand('git status'), 'neutral')
  assert.equal(classifyCommand('npm test'), 'neutral')
  assert.equal(classifyCommand(''), 'neutral')
})

test('collectArgsPaths / pathsFromCommand / pathsFromText: 提取路径', () => {
  assert.deepEqual(collectArgsPaths({ file_path: 'C:/a.txt', other: 'nope' }), ['C:/a.txt'])
  assert.deepEqual(collectArgsPaths({ files: ['C:/a.txt', 'C:/b.txt'] }), ['C:/a.txt', 'C:/b.txt'])
  assert.deepEqual(collectArgsPaths(null), [])

  const paths = pathsFromCommand('Move-Item "C:/a.txt" C:/b.txt; Remove-Item C:/c/d.txt')
  assert.ok(paths.includes('C:/a.txt'))
  assert.ok(paths.includes('C:/c/d.txt'))

  const fromText = pathsFromText('要改写 C:/Users/me/.dsh/cordis.yml 和 /home/me/.config/app.yml')
  assert.ok(fromText.includes('C:/Users/me/.dsh/cordis.yml'))
  assert.ok(fromText.includes('/home/me/.config/app.yml'))
  assert.deepEqual(pathsFromText('没有路径'), [])
})

test('pathsFromCommand: 只从会改动文件的命令段取路径，且拒收子表达式', () => {
  const destroyCmd = 'Remove-Item -Path .\\_probe.txt -Force; "exists=$(Test-Path .\\_probe.txt)"; Get-Content "$env:USERPROFILE\\.dsh\\a.log" -Tail 1'
  assert.deepEqual(pathsFromCommand(destroyCmd), ['.\\_probe.txt'])

  const writeCmd = 'Set-Location C:\\ws; Set-Content -Path .\\x.txt -Value y'
  assert.deepEqual(pathsFromCommand(writeCmd), ['.\\x.txt'])

  assert.deepEqual(pathsFromCommand('Remove-Item C:/a, C:/b'), ['C:/a', 'C:/b'])
})

test('approvalDisplayText: 删除卡片不再列出子表达式伪路径', () => {
  rememberToolCall({ callId: 'call-junk', name: 'pwsh', arguments: { command: 'Remove-Item .\\old.txt; "exists=$(Test-Path .\\old.txt)"' } })
  try {
    const text = approvalDisplayText({
      toolName: 'pwsh',
      callId: 'call-junk',
      reason: 'escalate sandbox to danger-full-access: 清理临时文件',
    })
    assert.match(text.zh, /old\.txt/)
    assert.doesNotMatch(text.zh, /Test-Path/)
    assert.doesNotMatch(text.zh, /\$\(/)
    assert.doesNotMatch(text.en, /\$\(/)
  } finally {
    forgetToolCall({ callId: 'call-junk' })
  }
})

test('approvalDisplayText: 沙箱提权但看不出命令 → 中性提示，带模式解释与理由', () => {
  const text = approvalDisplayText(sandboxRequest())
  assert.match(text.zh, /⚙️/)
  assert.match(text.zh, /danger-full-access/)
  assert.match(text.zh, /沙箱几乎完全关闭/)
  assert.match(text.zh, /只对这一次有效/)
  assert.match(text.zh, /需要读取工作区外的驱动版本信息/)
  assert.match(text.en, /Approval needed/)
  assert.match(text.en, /single request/)
})

test('approvalDisplayText: 写文件 → 写入警告 + 具体路径', () => {
  rememberToolCall({ callId: 'call-write', name: 'write', arguments: { file_path: 'C:/tmp/secret.txt', content: 'x' } })
  try {
    const text = approvalDisplayText({
      toolName: 'write',
      callId: 'call-write',
      reason: 'escalate sandbox to danger-full-access: 覆写工作区外的配置文件',
    })
    assert.match(text.zh, /⚠️ 会写入文件/)
    assert.match(text.zh, /C:\/tmp\/secret\.txt/)
    assert.match(text.zh, /覆写工作区外的配置文件/)
    assert.match(text.en, /FILE WRITES AHEAD/)
    assert.match(text.en, /C:\/tmp\/secret\.txt/)
    assert.doesNotMatch(text.zh, /高危操作/)
  } finally {
    forgetToolCall({ callId: 'call-write' })
  }
})

test('approvalDisplayText: 删除命令 → 高危 + 命令里提取的路径', () => {
  rememberToolCall({ callId: 'call-rm', name: 'pwsh', arguments: { command: 'Remove-Item C:/tmp/old.txt -Force' } })
  try {
    const text = approvalDisplayText({
      toolName: 'pwsh',
      callId: 'call-rm',
      reason: 'escalate sandbox to danger-full-access: 清理临时文件',
    })
    assert.match(text.zh, /🔴 高危操作/)
    assert.match(text.zh, /C:\/tmp\/old\.txt/)
    assert.match(text.zh, /从命令里提取/)
    assert.match(text.en, /DESTRUCTIVE OPERATION/)
  } finally {
    forgetToolCall({ callId: 'call-rm' })
  }
})

test('approvalDisplayText: git clean -fdx 也算高危（原先漏报）', () => {
  rememberToolCall({ callId: 'call-git', name: 'pwsh', arguments: { command: 'git clean -fdx' } })
  try {
    const text = approvalDisplayText({
      toolName: 'pwsh',
      callId: 'call-git',
      reason: 'escalate sandbox to danger-full-access: 清理未跟踪文件',
    })
    assert.match(text.zh, /🔴 高危操作/)
    assert.match(text.zh, /命令里没有写明具体路径/)
  } finally {
    forgetToolCall({ callId: 'call-git' })
  }
})

test('approvalDisplayText: 重定向目标算写入路径', () => {
  rememberToolCall({ callId: 'call-redirect', name: 'pwsh', arguments: { command: 'Get-Date > log.txt' } })
  try {
    const text = approvalDisplayText({
      toolName: 'pwsh',
      callId: 'call-redirect',
      reason: 'escalate sandbox to workspace-write: 记录时间',
    })
    assert.match(text.zh, /log\.txt/)
    assert.match(text.zh, /从命令里提取/)
  } finally {
    forgetToolCall({ callId: 'call-redirect' })
  }
})

test('approvalDisplayText: 只写命令 → 写入警告而不是高危（原先误报）', () => {
  rememberToolCall({ callId: 'call-log', name: 'pwsh', arguments: { command: 'Get-Date > log.txt' } })
  try {
    const text = approvalDisplayText({
      toolName: 'pwsh',
      callId: 'call-log',
      reason: 'escalate sandbox to workspace-write: 记录时间',
    })
    assert.match(text.zh, /⚠️ 会写入文件/)
    assert.doesNotMatch(text.zh, /🔴/)
  } finally {
    forgetToolCall({ callId: 'call-log' })
  }
})

test('approvalDisplayText: 读取 → 绿色只读提示，不出现高危警告', () => {
  rememberToolCall({ callId: 'call-read', name: 'read', arguments: { file_path: 'C:/logs/app.log' } })
  try {
    const text = approvalDisplayText({
      toolName: 'read',
      callId: 'call-read',
      reason: 'escalate sandbox to read-only: 读取日志定位问题',
    })
    assert.match(text.zh, /🟢 读取操作/)
    assert.match(text.zh, /C:\/logs\/app\.log/)
    assert.doesNotMatch(text.zh, /高危|会写入/)
    assert.match(text.en, /Read-only operation/)
  } finally {
    forgetToolCall({ callId: 'call-read' })
  }
})

test('approvalDisplayText: 拿不到工具参数时，从审批说明里兜底找路径', () => {
  const text = approvalDisplayText({
    toolName: 'write',
    reason: 'escalate sandbox to danger-full-access: 覆写 C:/Users/me/.dsh/profiles/desktop/cordis.patch.yml',
  })
  assert.match(text.zh, /cordis\.patch\.yml/)
  assert.match(text.zh, /从审批说明里提取/)
})

test('approvalDisplayText: 既没有参数也没有路径时给出明确占位', () => {
  const text = approvalDisplayText({ toolName: 'write', reason: 'escalate sandbox to danger-full-access: 写入文件' })
  assert.match(text.zh, /没能从参数里确定具体路径/)
  assert.match(text.en, /no concrete path/)
})

test('approvalDisplayText: 非沙箱审批保留原始说明', () => {
  const text = approvalDisplayText({
    toolName: 'some-tool',
    reason: 'tool "some-tool" requires approval',
    displayReason: { en: 'Allow the tool to run', zh: '允许该工具运行' },
  })
  assert.match(text.zh, /需要你批准/)
  assert.match(text.zh, /允许该工具运行/)
  assert.match(text.en, /Allow the tool to run/)
})

test('文案：不再出现人设词，英文不再有 widen 语法错', () => {
  const samples = [
    approvalDisplayText(sandboxRequest()),
    approvalDisplayText({
      toolName: 'write',
      callId: 'x-none',
      reason: 'escalate sandbox to danger-full-access: 写入',
    }),
    approvalDisplayText({ toolName: 'some-tool', reason: 'needs approval' }),
  ]
  for (const text of samples) {
    for (const value of [text.zh, text.en]) {
      assert.doesNotMatch(value, /本鱼/)
      assert.doesNotMatch(value, /this fish/i)
      assert.doesNotMatch(value, /\bIt widen\b|\bThis widen\b|\bwiden this one ".*" call to .*\)?, and it will change/)
      assert.doesNotMatch(value, /\{[a-z_]+\}/, 'unfilled placeholder')
    }
  }
})

test('语言包：中英 key 一致，模式解释齐全', () => {
  assert.deepEqual(Object.keys(ZH).sort(), Object.keys(EN).sort())
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access', 'fallback']) {
    assert.equal(typeof ZH[`mode.${mode}`], 'string')
    assert.equal(typeof EN[`mode.${mode}`], 'string')
  }
})

test('decorateApprovalRequest: 只改 displayReason，不动 reason', () => {
  const request = sandboxRequest()
  const before = request.reason
  assert.equal(decorateApprovalRequest(request), true)
  assert.equal(request.reason, before)
  assert.equal(typeof request.displayReason.zh, 'string')
  assert.equal(typeof request.displayReason.en, 'string')
})

test('applyQuestionRewrites: 合法的改写被应用，label 保持原样', () => {
  const questions = [
    {
      id: 'q1',
      question: 'Which sandbox mode should the retry use?',
      header: 'Mode',
      options: [
        { label: 'workspace-write', description: 'Write inside the workspace only' },
        { label: 'danger-full-access', description: 'No sandbox at all' },
      ],
      multi_select: false,
    },
  ]
  const rewritten = [
    {
      id: 'q1',
      question: '这次重试用哪种权限？',
      header: '权限',
      options: [
        { label: 'workspace-write', description: '只能写工作区里的文件' },
        { label: 'danger-full-access', description: '完全不限制' },
      ],
    },
  ]
  assert.equal(applyQuestionRewrites(questions, rewritten), true)
  assert.equal(questions[0].question, '这次重试用哪种权限？')
  assert.equal(questions[0].header, '权限')
  assert.equal(questions[0].options[0].label, 'workspace-write')
  assert.equal(questions[0].options[1].description, '完全不限制')
  assert.equal(questions[0].multi_select, false)
})

test('applyQuestionRewrites: label / id / 数量对不上时整体拒绝', () => {
  const questions = [{ id: 'q1', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }]
  const badLabel = [{ id: 'q1', question: '问题？', options: [{ label: 'a' }, { label: 'B' }] }]
  const badId = [{ id: 'q2', question: '问题？', options: [{ label: 'A' }, { label: 'B' }] }]
  const badCount = [{ id: 'q1', question: '问题？', options: [{ label: 'A' }] }]
  assert.equal(applyQuestionRewrites(questions, badLabel), false)
  assert.equal(applyQuestionRewrites(questions, badId), false)
  assert.equal(applyQuestionRewrites(questions, badCount), false)
  assert.equal(questions[0].question, 'Q?')
})

test('applyQuestionRewrites: 非中文 label 可以补解释，中文 label 不行', () => {
  const englishLabel = [{ id: 'q1', question: 'Q?', options: [{ label: 'workspace-write' }] }]
  const withExplanation = [
    { id: 'q1', question: '问题？', options: [{ label: 'workspace-write', description: '只能写工作区里的文件' }] },
  ]
  assert.equal(applyQuestionRewrites(englishLabel, withExplanation), true)
  assert.equal(englishLabel[0].options[0].description, '只能写工作区里的文件')

  const chineseLabel = [{ id: 'q1', question: 'Q?', options: [{ label: '继续' }] }]
  const extra = [{ id: 'q1', question: '问题？', options: [{ label: '继续', description: '凭空加的说明' }] }]
  assert.equal(applyQuestionRewrites(chineseLabel, extra), false)
  assert.equal(chineseLabel[0].options[0].description, undefined)

  const hadDescription = [{ id: 'q1', question: 'Q?', options: [{ label: '继续', description: '原说明' }] }]
  const dropped = [{ id: 'q1', question: '问题？', options: [{ label: '继续' }] }]
  assert.equal(applyQuestionRewrites(hadDescription, dropped), false)
})

test('parseRewrittenArray: 容忍代码块围栏', () => {
  const parsed = parseRewrittenArray('```json\n[{"id":"q1","question":"x"}]\n```')
  assert.deepEqual(parsed, [{ id: 'q1', question: 'x' }])
  assert.equal(parseRewrittenArray('not json'), null)
  assert.equal(parseRewrittenArray('{"id":"q1"}'), null)
})

test('buildRewritePrompt: 含铁律与输入 JSON', () => {
  const prompt = buildRewritePrompt([{ id: 'q1', question: 'Q?' }])
  assert.match(prompt, /label/)
  assert.match(prompt, /只输出 JSON/)
  assert.match(prompt, /"q1"/)
})

test('needsRewrite: 只看会展示的文字，已是中文就不改', () => {
  assert.equal(needsRewrite({ id: 'q', question: 'Continue?' }), true)
  assert.equal(needsRewrite({ id: 'q', question: '继续吗？' }), false)
  assert.equal(
    needsRewrite({ id: 'q', question: '继续吗？', options: [{ label: 'yes', description: 'Keep going' }] }),
    true,
  )
  assert.equal(
    needsRewrite({ id: 'q', question: '继续吗？', options: [{ label: 'yes', description: '继续做' }] }),
    false,
  )
  assert.equal(needsRewrite(null), false)
})

function fakeCtx(chunks, { throwOnStream = false } = {}) {
  const state = { streams: [] }
  const ctx = {
    get(service) {
      if (service !== 'llm') return undefined
      return {
        listProviders: () => ['deepseek-account'],
        stream(request) {
          state.streams.push(request)
          if (throwOnStream) throw new Error('boom')
          return (async function* () {
            for (const chunk of chunks) yield chunk
          })()
        },
      }
    },
  }
  return { ctx, state }
}

test('rewriteQuestions: 成功时改写并保留 label', async () => {
  const answer = JSON.stringify([
    {
      id: 'q1',
      question: '要不要继续？',
      options: [{ label: 'yes', description: '继续做' }, { label: 'no', description: '停下来' }],
    },
  ])
  const { ctx, state } = fakeCtx([
    { type: 'text-delta', text: answer.slice(0, 10) },
    { type: 'text-delta', text: answer.slice(10) },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const request = {
    agent: { options: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    questions: [{
      id: 'q1',
      question: 'Continue?',
      options: [
        { label: 'yes', description: 'Keep going' },
        { label: 'no', description: 'Stop here' },
      ],
    }],
  }
  assert.equal(await rewriteQuestions(ctx, request), true)
  assert.equal(request.questions[0].question, '要不要继续？')
  assert.equal(request.questions[0].options[0].label, 'yes')
  assert.equal(state.streams.length, 1)
})

test('rewriteQuestions: 相同内容第二次命中缓存，不再调用模型', async () => {
  const answer = JSON.stringify([{ id: 'qc', question: '缓存命中测试？' }])
  const { ctx, state } = fakeCtx([
    { type: 'text-delta', text: answer },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const make = () => ({ agent: { options: {} }, questions: [{ id: 'qc', question: 'Cache hit test?' }] })
  const first = make()
  const second = make()
  assert.equal(await rewriteQuestions(ctx, first), true)
  assert.equal(await rewriteQuestions(ctx, second), true)
  assert.equal(state.streams.length, 1)
  assert.equal(second.questions[0].question, '缓存命中测试？')
})

test('rewriteQuestions: 只读的问题对象也能改写（克隆后替换数组）', async () => {
  const answer = JSON.stringify([{ id: 'q1', question: '请继续？' }])
  const { ctx } = fakeCtx([
    { type: 'text-delta', text: answer },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const frozenQuestions = deepFreezeValue([{ id: 'q1', question: 'Proceed?' }])
  const request = { agent: { options: {} }, questions: frozenQuestions }
  assert.equal(await rewriteQuestions(ctx, request), true)
  assert.equal(request.questions[0].question, '请继续？')
  assert.equal(frozenQuestions[0].question, 'Proceed?')
  assert.equal(Object.isFrozen(frozenQuestions[0]), true)
})

function deepFreezeValue(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreezeValue(value[key])
    Object.freeze(value)
  }
  return value
}

test('rewriteQuestions: 全是中文时整批跳过，不调模型', async () => {
  const { ctx, state } = fakeCtx([{ type: 'finish', reason: { kind: 'stop' } }])
  const request = {
    agent: { options: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    questions: [{ id: 'q1', question: '要继续吗？', options: [{ label: 'yes', description: '继续做' }] }],
  }
  assert.equal(await rewriteQuestions(ctx, request), false)
  assert.equal(state.streams.length, 0)
  assert.equal(request.questions[0].question, '要继续吗？')
})

test('rewriteQuestions: 混合语言时只交非中文的问题给模型', async () => {
  const answer = JSON.stringify([{ id: 'q2', question: '请继续？' }])
  const { ctx, state } = fakeCtx([
    { type: 'text-delta', text: answer },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const request = {
    agent: { options: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    questions: [
      { id: 'q1', question: '要继续吗？' },
      { id: 'q2', question: 'Proceed?' },
    ],
  }
  assert.equal(await rewriteQuestions(ctx, request), true)
  const prompt = state.streams[0].messages[0].content[0].text
  assert.match(prompt, /q2/)
  assert.doesNotMatch(prompt, /q1/)
  assert.equal(request.questions[0].question, '要继续吗？')
  assert.equal(request.questions[1].question, '请继续？')
})

test('rewriteQuestions: 无 agent / 模型报错 / 输出不合法时保持原样', async () => {
  const { ctx } = fakeCtx([{ type: 'finish', reason: { kind: 'error' } }])

  const noAgent = { questions: [{ id: 'q1', question: 'Continue?' }] }
  assert.equal(await rewriteQuestions(ctx, noAgent), false)

  const errorCtx = fakeCtx([{ type: 'finish', reason: { kind: 'error' } }])
  const withAgent = { agent: { options: {} }, questions: [{ id: 'q1', question: 'Continue?' }] }
  assert.equal(await rewriteQuestions(errorCtx.ctx, withAgent), false)
  assert.equal(withAgent.questions[0].question, 'Continue?')

  const badCtx = fakeCtx([{ type: 'text-delta', text: '{"oops":true}' }, { type: 'finish', reason: { kind: 'stop' } }])
  const bad = { agent: { options: {} }, questions: [{ id: 'q1', question: 'Continue?' }] }
  assert.equal(await rewriteQuestions(badCtx.ctx, bad), false)
  assert.equal(bad.questions[0].question, 'Continue?')

  const throwing = fakeCtx([], { throwOnStream: true })
  const th = { agent: { options: {} }, questions: [{ id: 'q1', question: 'Continue?' }] }
  assert.equal(await rewriteQuestions(throwing.ctx, th), false)
})

test('apply: 注册四个监听器，pre-execute 缓存参数供审批分级使用', () => {
  const registered = []
  const ctx = {
    on(event, listener, options) {
      registered.push({ event, listener, options })
      return () => {}
    },
  }
  apply(ctx)
  const byEvent = (event) => registered.find((entry) => entry.event === event)
  assert.equal(registered.length, 4)
  assert.deepEqual(byEvent('tools/pre-execute').options, { prepend: true, global: true })
  assert.deepEqual(byEvent('approval/request').options, { prepend: true, global: true })
  assert.deepEqual(byEvent('user-questions/request').options, { prepend: true, global: true })
  assert.equal(byEvent('tools/result').event, 'tools/result')

  const exec = { callId: 'apply-call', name: 'write', arguments: { file_path: 'C:/tmp/applied.txt' } }
  assert.deepEqual(byEvent('tools/pre-execute').listener(exec, () => ({ kind: 'allow' })), { kind: 'allow' })
  const request = {
    toolName: 'write',
    callId: 'apply-call',
    reason: 'escalate sandbox to danger-full-access: 应用配置',
  }
  const outcome = byEvent('approval/request').listener(request, () => 'unavailable')
  assert.equal(outcome, 'unavailable')
  assert.match(request.displayReason.zh, /⚠️ 会写入文件/)
  assert.match(request.displayReason.zh, /C:\/tmp\/applied\.txt/)

  byEvent('tools/result').listener(exec)
  const afterCleanup = {
    toolName: 'write',
    callId: 'apply-call',
    reason: 'escalate sandbox to danger-full-access: 应用配置',
  }
  byEvent('approval/request').listener(afterCleanup, () => 'unavailable')
  assert.doesNotMatch(afterCleanup.displayReason.zh, /C:\/tmp\/applied\.txt/)
  assert.match(afterCleanup.displayReason.zh, /没能从参数里确定具体路径/)
})

/* ── v1.1.0：套娃命令（不直接删文件，而是用 bash -c / python -c 套一层） ──── */

const utf16Base64 = (script) => Buffer.from(script, 'utf16le').toString('base64')

test('套娃：findNestedScripts 认出各种「把字符串当脚本再执行」的写法', () => {
  assert.deepEqual(findNestedScripts('bash -c "rm -rf ./build"'), [{ script: 'rm -rf ./build', encoded: false }])
  assert.deepEqual(findNestedScripts("sh -c 'rm -rf /tmp/out'"), [{ script: 'rm -rf /tmp/out', encoded: false }])
  assert.deepEqual(findNestedScripts('cmd /c "del C:/tmp/a.txt"'), [{ script: 'del C:/tmp/a.txt', encoded: false }])
  assert.equal(
    findNestedScripts('python -c "import shutil; shutil.rmtree(\'dist\')"')[0].script,
    "import shutil; shutil.rmtree('dist')",
  )
  assert.equal(
    findNestedScripts('pwsh -NoProfile -Command "Remove-Item ./logs -Recurse"')[0].script,
    'Remove-Item ./logs -Recurse',
  )

  const encoded = findNestedScripts(`powershell -EncodedCommand ${utf16Base64('Remove-Item C:/x/y.txt')}`)[0]
  assert.equal(encoded.encoded, true)
  assert.equal(Buffer.from(encoded.script, 'base64').toString('utf16le'), 'Remove-Item C:/x/y.txt')

  // 不是「执行代码」的开关，不该被当成套娃
  assert.deepEqual(findNestedScripts('bash -x ./script.sh'), [])
  assert.deepEqual(findNestedScripts('python script.py'), [])
  assert.deepEqual(findNestedScripts('node --version'), [])
})

test('套娃：删除 / 覆盖藏在内层也会被抓住', () => {
  const cases = [
    'bash -c "rm -rf ./build"',
    "sh -c 'rm -rf /tmp/out'",
    'cmd /c "del C:/tmp/a.txt"',
    `python -c "import shutil; shutil.rmtree('dist')"`,
    'pwsh -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item ./logs -Recurse -Force"',
    `powershell -EncodedCommand ${utf16Base64('Remove-Item C:/x/y.txt -Force')}`,
  ]
  for (const command of cases) {
    const result = classifyCommandDeep(command)
    assert.equal(result.kind, 'destroy', `应判为高危：${command}`)
    assert.equal(result.truncated, false, `不该截断：${command}`)
    assert.ok(result.depth >= 1, `应至少展开一层：${command}`)
  }
})

test('套娃：写入算写入；无害套娃不误报，但仍记层数', () => {
  const write = classifyCommandDeep('bash -c "echo hi > ./out.txt"')
  assert.equal(write.kind, 'write')
  assert.ok(write.paths.includes('./out.txt'), JSON.stringify(write.paths))

  const harmless = classifyCommandDeep('bash -c "echo hi"')
  assert.equal(harmless.kind, 'neutral')
  assert.equal(harmless.depth, 1, '看过一层，只是里面没有危险动作')
})

test('套娃：两层也能追到最里面', () => {
  const result = classifyCommandDeep(`bash -c "pwsh -Command 'Remove-Item ./a.txt'"`)
  assert.equal(result.kind, 'destroy')
  assert.equal(result.depth, 2)
})

test('套娃：无限套娃必须浅尝辄止（不能死循环）', () => {
  let command = 'rm -rf ./x'
  for (let index = 0; index < 200; index += 1) command = `bash -c "${command.replace(/"/g, '\\"')}"`
  const started = Date.now()
  const result = classifyCommandDeep(command)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2000, `不能卡：${elapsed}ms`)
  assert.ok(result.depth <= 3, `深度要有上限，实际 ${result.depth}`)
  assert.equal(result.truncated, true, '看不完就要如实标记')
})

test('套娃：一层里塞几十个也不卡，危险动作能被抓到', () => {
  const parts = ['bash -c "rm -rf ./secret"']
  for (let index = 0; index < 40; index += 1) parts.push(`bash -c "echo ${index}"`)
  const started = Date.now()
  const result = classifyCommandDeep(parts.join('; '))
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1000, `不能卡：${elapsed}ms`)
  assert.equal(result.kind, 'destroy')
})

test('套娃：超长命令先截断再分析', () => {
  const command = `bash -c "${'echo a; '.repeat(4000)}rm -rf ./hidden"`
  assert.ok(command.length > 20_000)
  const started = Date.now()
  const result = classifyCommandDeep(command)
  assert.ok(Date.now() - started < 1000)
  assert.equal(result.truncated, true)
})

test('套娃：审批卡片标红，并说明「里面也看过」', () => {
  const callId = 'nested-card'
  rememberToolCall({ callId, name: 'bash', arguments: { command: 'bash -c "rm -rf ./build"' } })
  const text = approvalDisplayText({ toolName: 'bash', callId, reason: 'escalate sandbox to danger-full-access: 清理构建目录' })
  assert.match(text.zh, /🔴/)
  assert.match(text.zh, /\.\/build/)
  assert.match(text.zh, /套了一层命令/)
  assert.match(text.en, /another script inside/)
  forgetToolCall({ callId })
})

/* ── v1.1.0：多个窗口同时干活时，缓存不能串台、不能无限涨 ─────────────────── */

test('缓存：不同会话的同名 callId 不串台', () => {
  const callId = 'shared-call-id'
  rememberToolCall({ callId, name: 'write', arguments: { file_path: 'C:/tmp/only-a.txt' }, agent: { id: 'agent-a' } })

  const fromB = approvalDisplayText({
    toolName: 'write',
    callId,
    agent: { id: 'agent-b' },
    reason: 'escalate sandbox to danger-full-access: 另一个窗口',
  })
  assert.doesNotMatch(fromB.zh, /only-a\.txt/, 'B 窗口不该看到 A 窗口的参数')

  const fromA = approvalDisplayText({
    toolName: 'write',
    callId,
    agent: { id: 'agent-a' },
    reason: 'escalate sandbox to danger-full-access: 同一个窗口',
  })
  assert.match(fromA.zh, /only-a\.txt/)

  // 两侧都拿不到作用域时退回按 callId 匹配——不能因此把功能丢了
  const anonymous = approvalDisplayText({
    toolName: 'write',
    callId,
    reason: 'escalate sandbox to danger-full-access: 没有 agent 信息',
  })
  assert.match(anonymous.zh, /only-a\.txt/)
  forgetToolCall({ callId })
})

test('缓存：条数与字节都有上限；把命令撑大也躲不过审查', () => {
  const pad = 'x'.repeat(1024)
  for (let index = 0; index < 400; index += 1) {
    rememberToolCall({ callId: `bulk-${index}`, name: 'write', arguments: { file_path: `C:/tmp/${index}.txt`, pad } })
  }
  const stats = cacheStats()
  assert.ok(stats.calls <= 256, `条数要有上限，实际 ${stats.calls}`)
  assert.ok(stats.callBytes <= 2 * 1024 * 1024, `字节要有上限，实际 ${stats.callBytes}`)

  // 只存结论不存原文：超大命令不该把缓存撑大，但分级必须还在
  // （否则「把命令撑到几百 KB」就成了绕过审查的办法）。
  const hugeCommand = `bash -c "rm -rf ./hidden; ${'echo a; '.repeat(4000)}"`
  assert.ok(hugeCommand.length > 20_000)
  const beforeBytes = cacheStats().callBytes
  rememberToolCall({ callId: 'huge', name: 'bash', arguments: { command: hugeCommand } })
  assert.ok(cacheStats().callBytes - beforeBytes < 64 * 1024, '缓存里只该存结论，不该存几百 KB 的命令原文')

  const card = approvalDisplayText({ toolName: 'bash', callId: 'huge', reason: 'escalate sandbox to danger-full-access: 大命令' })
  assert.match(card.zh, /🔴/, '把命令撑大也不能让分级退回「看不出」')
})

/* ── v1.1.0：日志异步落盘，不卡主程序 ───────────────────────────────────── */

test('日志：入队即返回（不阻塞），队列有界，落盘是异步的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plain-approvals-log-'))
  const file = join(dir, 'app.log')
  process.env.DSH_PLAIN_APPROVALS_LOG = file
  try {
    for (let index = 0; index < 700; index += 1) debugLog(`event ${index}`)
    const queued = cacheStats().logQueued
    assert.ok(queued > 0, 'debugLog 不能同步写盘（队列里应还有内容）')
    assert.ok(queued <= 500, `队列要有界，实际 ${queued}`)

    await flushLog()
    assert.equal(cacheStats().logQueued, 0, 'flush 之后队列必须清空')
    const text = readFileSync(file, 'utf8')
    assert.match(text, /event 0/)
    assert.match(text, /log queue overflow/, '丢弃过的行数要留痕')
  } finally {
    delete process.env.DSH_PLAIN_APPROVALS_LOG
    rmSync(dir, { recursive: true, force: true })
  }
})

test('日志：写不进去也不许抛错（日志永远不是功能的一部分）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plain-approvals-badlog-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  process.env.DSH_PLAIN_APPROVALS_LOG = join(blocker, 'nested', 'app.log')
  try {
    debugLog('这条写不进去')
    await flushLog()
    assert.equal(cacheStats().logQueued, 0)
  } finally {
    delete process.env.DSH_PLAIN_APPROVALS_LOG
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ── v1.1.1：没看完要说清「为什么没看完」 ───────────────────────────────── */

test('截断原因：扁平超长命令说「太长」，不冒充「套娃太深」', () => {
  const flat = 'echo ok; '.repeat(3000)
  const result = classifyCommandDeep(flat)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.truncatedBy, ['length'])
  assert.equal(result.depth, 0, '这条命令根本没有套娃')

  rememberToolCall({ callId: 'flat-long', name: 'pwsh', arguments: { command: flat } })
  const card = approvalDisplayText({
    toolName: 'pwsh',
    callId: 'flat-long',
    reason: 'escalate sandbox to danger-full-access: 长命令',
  })
  assert.match(card.zh, /命令太长/)
  assert.doesNotMatch(card.zh, /套娃太深/, '没有套娃就不能说套娃')
  assert.match(card.en, /very long/)
  forgetToolCall({ callId: 'flat-long' })
})

test('截断原因：多级转义把结构打散时，也必须承认「没看完」', () => {
  // 20 层 `bash -c "…\"…\"…"` 会把引号结构逐层打散：解析不出完整子脚本。
  // 这种情况绝不能静默 —— 必须标成「层数上限」，让用户知道要自己看。
  let deep = 'rm -rf ./x'
  for (let index = 0; index < 20; index += 1) deep = `bash -c "${deep.replace(/"/g, '\\"')}"`
  const result = classifyCommandDeep(deep)
  assert.equal(result.truncated, true, '解析不完整就必须标注')
  assert.ok(result.truncatedBy.includes('depth'), JSON.stringify(result.truncatedBy))
})

test('截断原因：真套娃才说「套娃太深」（编码套娃最典型）', () => {
  // base64 把下一层藏起来，只能逐层解开——这才真的会撞上深度上限
  let script = 'Remove-Item ./a.txt'
  for (let index = 0; index < 4; index += 1) script = `powershell -EncodedCommand ${utf16Base64(script)}`
  const result = classifyCommandDeep(script)
  assert.equal(result.truncated, true)
  assert.ok(result.truncatedBy.includes('depth'), JSON.stringify(result.truncatedBy))

  rememberToolCall({ callId: 'deep-encoded', name: 'pwsh', arguments: { command: script } })
  const card = approvalDisplayText({
    toolName: 'pwsh',
    callId: 'deep-encoded',
    reason: 'escalate sandbox to danger-full-access: 编码套娃',
  })
  assert.match(card.zh, /套娃太深/)
  assert.doesNotMatch(card.zh, /命令太长/)
  forgetToolCall({ callId: 'deep-encoded' })
})

test('截断原因：一层里塞太多，记成「展开次数用尽」', () => {
  const parts = []
  for (let index = 0; index < 40; index += 1) parts.push(`bash -c "echo ${index}"`)
  const result = classifyCommandDeep(parts.join('; '))
  assert.equal(result.truncated, true)
  assert.ok(result.truncatedBy.includes('width'), JSON.stringify(result.truncatedBy))
})
