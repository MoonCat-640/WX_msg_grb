/**
 * 核心逻辑自检（无需 Electron，直接 node 跑）
 * ------------------------------------------------------------------
 * 覆盖两处「有真实逻辑、且出错代价高」的纯函数模块：
 *   1. dedup.ts    任务去重与合并（更新需求 §5 —— 用户报的 bug 就在这里）
 *   2. classify.ts 任务状态分类（更新需求 §4 —— 新增「已删除」分类的规则）
 *
 * 为什么单独做这个自检：这两块是纯函数，可以脱离 GUI / 数据库 / LLM 验证；
 * 而它们的错误表现都很隐蔽（任务悄悄重复、已完成被改回进行中、删掉的又跑回来），
 * 靠肉眼看界面很难发现。
 *
 * 用法：node scripts/core-logic.selftest.cjs
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const root = path.resolve(__dirname, '..')
const esbuild = path.join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')

/** 用仓库自带的 esbuild 把一个 TS 模块打成 CJS 并 require 进来 */
function loadModule(relPath) {
  const out = path.join(os.tmpdir(), 'wxgrb-selftest-' + path.basename(relPath).replace(/\.ts$/, '') + '.cjs')
  execFileSync(
    esbuild,
    [
      path.join(root, relPath),
      '--bundle',
      '--format=cjs',
      '--platform=node',
      '--outfile=' + out,
      '--log-level=warning'
    ],
    { stdio: 'inherit' }
  )
  const mod = require(out)
  return { mod, cleanup: () => { try { fs.unlinkSync(out) } catch { /* 忽略 */ } } }
}

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  [PASS] ' + name)
  } else {
    fail++
    console.log('  [FAIL] ' + name + (extra !== undefined ? '  → ' + extra : ''))
  }
}
function section(t) {
  console.log('\n=== ' + t + ' ===')
}

const DAY = 86400000
const t0 = Date.UTC(2026, 8, 20, 0, 0) // 2026-09-20 08:00 UTC+8

/* ================================================================== */
/* 一、任务去重（dedup.ts）                                            */
/* ================================================================== */
const dedupBundle = loadModule('src/main/tasks/dedup.ts')
const dedup = dedupBundle.mod

section('1. sameIdentity —— 名称 + 发布人 + 起始时间')
const base = { name: '数学建模竞赛报名', startAt: t0, publisherNames: ['张明'] }
check('三项全同 → 同一任务', dedup.sameIdentity(base, { ...base }) === true)
check('名称不同 → 不是', dedup.sameIdentity(base, { ...base, name: '英语竞赛报名' }) === false)
check('发布人不同 → 不是', dedup.sameIdentity(base, { ...base, publisherNames: ['李雷'] }) === false)
check('起始时间差 3 天 → 不是', dedup.sameIdentity(base, { ...base, startAt: t0 + 3 * DAY }) === false)
check('起始时间差 30 分钟 → 是（容差内）', dedup.sameIdentity(base, { ...base, startAt: t0 + 30 * 60000 }) === true)
check(
  '双方都没有时间 → 视为一致',
  dedup.sameIdentity(
    { name: 'x', startAt: undefined, publisherNames: ['张明'] },
    { name: 'x', startAt: undefined, publisherNames: ['张明'] }
  ) === true
)
check('一方有时间一方没有 → 不是', dedup.sameIdentity(base, { ...base, startAt: undefined }) === false)

section('2. findDuplicate —— 必须能命中其它分类里的同一条')
const doneTask = {
  id: 't-done',
  fingerprint: '',
  features: {
    name: '数学建模竞赛报名',
    topic: '报名参加2026年数学建模竞赛',
    startAt: t0,
    endAt: t0 + 10 * DAY,
    materials: [],
    organizers: ['教务处']
  },
  publisherNames: ['张明'],
  status: 'done',
  createdAt: 1000
}
const draft = {
  name: '数学建模竞赛报名',
  topic: '报名参加2026年数学建模竞赛',
  startAt: t0,
  endAt: t0 + 10 * DAY,
  materials: [],
  organizers: ['教务处']
}
const hit = dedup.findDuplicate({ ...draft, publisherNames: ['张明'] }, '', [doneTask])
check('命中「已完成」里的同一任务', hit !== null && hit.candidate.id === 't-done')
check('依据是三元组，不是相似度兜底', hit !== null && hit.reason === 'identity', hit && hit.reason)
check(
  '名称有细微差异 + 发布人时间一致 → 仍判定为同一条',
  dedup.findDuplicate({ ...draft, name: '数学建模竞赛 报名', publisherNames: ['张明'] }, '', [doneTask]) !== null
)
check(
  '完全不同的任务不被误判',
  dedup.findDuplicate(
    { name: '英语四级报名', topic: '四级考试报名', startAt: t0 + 60 * DAY, materials: [], organizers: ['外语学院'] },
    '',
    [doneTask]
  ) === null
)

section('3. mergeIntoTask —— 合并必须保留原状态')
const existing = {
  id: 't-done',
  name: '数学建模竞赛报名',
  topic: '报名参加2026年数学建模竞赛',
  type: '报名',
  organizers: ['教务处'],
  startAt: t0,
  endAt: t0 + 10 * DAY,
  materials: [],
  contactPerson: '王老师',
  originalText: '原文',
  publishers: [
    { name: '张明', accountId: 'a1', platform: 'wechat', conversationId: 'c1', conversationName: '通知群', isSelf: false, publishedAt: t0 }
  ],
  sourceMessageIds: ['m1'],
  status: 'done',
  statusLocked: true,
  deleted: false,
  tileOrder: 1,
  fingerprint: 'fp',
  createdAt: 1000,
  updatedAt: 1000
}
const merged = dedup.mergeIntoTask(
  existing,
  {
    name: '数学建模竞赛报名（另一群）',
    topic: '报名',
    type: '报名',
    organizers: ['数学学院'],
    startAt: t0,
    endAt: t0 + 10 * DAY,
    materials: [{ name: '报名表', kind: 'document', required: true }],
    contactPerson: '王老师',
    originalText: '另一群的原文'
  },
  { name: '李雷', accountId: 'a2', platform: 'wechat', conversationId: 'c2', conversationName: '二班群', isSelf: false, publishedAt: t0 + 3600000 },
  ['m2']
)
check('合并后仍是「已完成」', merged.status === 'done', merged.status)
check('合并后仍锁定（不被自动分类改回）', merged.statusLocked === true)
check('发布人合并为 2 条', merged.publishers.length === 2, String(merged.publishers.length))
check('第一位仍是最早发布的张明', merged.publishers[0].name === '张明', merged.publishers[0].name)
check('材料被合并进来', merged.materials.length === 1)
check('来源消息被合并', merged.sourceMessageIds.length === 2)

/* ================================================================== */
/* 二、任务状态分类（classify.ts）                                     */
/* ================================================================== */
const classifyBundle = loadModule('src/main/tasks/classify.ts')
const cls = classifyBundle.mod
const NOW = t0 + 5 * DAY

section('4. classifyStatus —— 时间自动分类')
check(
  '无任何时间 → 进行中',
  cls.classifyStatus({ startAt: undefined, endAt: undefined, status: 'ongoing', statusLocked: false }, NOW) === 'ongoing'
)
check(
  '截止时间已过 → 已过期',
  cls.classifyStatus({ startAt: t0, endAt: t0 + DAY, status: 'ongoing', statusLocked: false }, NOW) === 'expired'
)
check(
  '还没到开始时间 → 未开始',
  cls.classifyStatus({ startAt: NOW + DAY, endAt: NOW + 2 * DAY, status: 'ongoing', statusLocked: false }, NOW) === 'upcoming'
)
check(
  '进行中（在区间内）',
  cls.classifyStatus({ startAt: t0, endAt: t0 + 30 * DAY, status: 'ongoing', statusLocked: false }, NOW) === 'ongoing'
)

section('5. 人工确认不被时间覆盖（原版需求「人工确认」）')
check(
  '已完成的不会被超期改成已过期',
  cls.classifyStatus({ startAt: t0, endAt: t0 + DAY, status: 'done', statusLocked: true }, NOW) === 'done'
)
check(
  '未开始被人工改成已完成 → 保持已完成',
  cls.classifyStatus({ startAt: NOW + 5 * DAY, endAt: NOW + 6 * DAY, status: 'done', statusLocked: true }, NOW) === 'done'
)

section('6. 「已删除」不参与时间自动分类（更新需求 §4）')
check(
  '已删除的即使超期也仍是已删除',
  cls.classifyStatus({ startAt: t0, endAt: t0 + DAY, status: 'deleted', statusLocked: false }, NOW) === 'deleted'
)
check(
  '已删除的即使未到开始时间也仍是已删除',
  cls.classifyStatus({ startAt: NOW + 10 * DAY, endAt: NOW + 11 * DAY, status: 'deleted', statusLocked: false }, NOW) === 'deleted'
)

section('7. statusAfterRestore —— 恢复时按时间重新归类（不直接扔回进行中）')
check(
  '恢复一个已超期的任务 → 归入「已过期」（关键：不是进行中）',
  cls.statusAfterRestore({ startAt: t0, endAt: t0 + DAY, status: 'deleted', statusLocked: false }, NOW) === 'expired'
)
check(
  '恢复一个还没开始的任务 → 归入「未开始」',
  cls.statusAfterRestore({ startAt: NOW + 5 * DAY, endAt: NOW + 6 * DAY, status: 'deleted', statusLocked: false }, NOW) === 'upcoming'
)
check(
  '恢复一个正在进行的任务 → 归入「进行中」',
  cls.statusAfterRestore({ startAt: t0, endAt: t0 + 30 * DAY, status: 'deleted', statusLocked: false }, NOW) === 'ongoing'
)
check(
  '恢复一个没有时间的任务 → 归入「进行中」',
  cls.statusAfterRestore({ startAt: undefined, endAt: undefined, status: 'deleted', statusLocked: false }, NOW) === 'ongoing'
)

section('8. 状态文案与顺序（与界面契约一致）')
check('5 个状态都有中文名', Object.keys(cls.STATUS_LABEL).length === 5, Object.keys(cls.STATUS_LABEL).join(','))
check('「已删除」在最后', cls.STATUS_ORDER[cls.STATUS_ORDER.length - 1] === 'deleted')
check('「已删除」中文名正确', cls.STATUS_LABEL.deleted === '已删除')

section('9. 任务来源标记 origin（第二次更新需求 §1）')
// 自动抽取产生的一律 auto；手动新建的为 manual。
// 界面的「来源信息不可修改」与磁贴上的「手动」角标都依赖这个字段。
const autoTask = dedup.createTaskFromDraft({
  id: 't-auto',
  draft: {
    name: '自动抽取的任务',
    topic: '主题',
    type: '报名',
    organizers: [],
    materials: [],
    originalText: '聊天原文'
  },
  publisher: {
    name: '张明',
    accountId: 'a1',
    platform: 'wechat',
    conversationId: 'c1',
    conversationName: '通知群',
    isSelf: false,
    publishedAt: t0
  },
  sourceMessageIds: ['m1'],
  status: 'ongoing',
  tileOrder: 5
})
check('自动抽取的任务 origin = auto', autoTask.origin === 'auto', String(autoTask.origin))

const manualMerged = dedup.mergeIntoTask(
  { ...autoTask, origin: 'manual' },
  {
    name: '手动任务',
    topic: '主题',
    type: '',
    organizers: [],
    materials: [],
    originalText: '手动补充的说明'
  },
  {
    name: '李雷',
    accountId: 'a2',
    platform: 'wechat',
    conversationId: 'c2',
    conversationName: '二班群',
    isSelf: false,
    publishedAt: t0 + 1000
  },
  ['m2']
)
check('合并后 origin 保持不变（manual 不会被改成 auto）', manualMerged.origin === 'manual', String(manualMerged.origin))

/* ================================================================== */
dedupBundle.cleanup()
classifyBundle.cleanup()

console.log('\n========================================')
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log('========================================\n')
process.exit(fail === 0 ? 0 : 1)
