/**
 * 任务状态分类（纯函数，不依赖数据库）
 * ------------------------------------------------------------------
 * 为什么单独拆一个文件：
 *   `task-repo.ts`（恢复任务时要重算状态）与 `status.ts`（定时重分类要读写数据库）
 *   互相需要对方的能力，直接互相 import 会形成循环依赖。
 *   把**纯计算**放这里，两边都引它，循环就断了。
 *
 * 规则来源（原版需求「模块 9」+ 更新需求 §4）：
 *   ① 已删除：用户主动放进去的分类，不参与时间自动分类
 *   ② 人工确认过（statusLocked）：不被自动分类覆盖
 *   ③ 当前时间 > 截止时间 → 已过期
 *   ④ 当前时间 < 开始时间 → 未开始
 *   ⑤ 其余（含无时间信息）→ 进行中
 */
import type { TaskStatus } from '@shared/types'

export interface ClassifiableTask {
  startAt?: number
  endAt?: number
  status: TaskStatus
  statusLocked: boolean
}

/** 计算某个任务在当前时刻应有的状态 */
export function classifyStatus(task: ClassifiableTask, now: number): TaskStatus {
  // ① 「已删除」是用户主动放进去的分类，不参与时间自动分类。
  //    否则一个已删除的旧任务会因为超期被改成「已过期」而跑到别的标签页去。
  if (task.status === 'deleted') return 'deleted'

  // ② 人工确认过的状态不参与自动分类（「已完成」尤其不能被时间改回去）
  if (task.statusLocked) return task.status

  // ③ 截止时间已过 → 已过期
  if (task.endAt !== undefined && task.endAt !== null && now > task.endAt) {
    return 'expired'
  }

  // ④ 还没到开始时间 → 未开始
  if (task.startAt !== undefined && task.startAt !== null && now < task.startAt) {
    return 'upcoming'
  }

  // ⑤ 其余（含无时间信息）→ 进行中
  return 'ongoing'
}

/**
 * 从「已删除」恢复时该归到哪个分类。
 *
 * 更新需求 §4 边界要求：**不直接扔回「进行中」**，而是按起止时间和当前时间
 * （UTC+8）重新判定。这里复用同一套规则，把 status 当作「新任务」传入
 * （ongoing + 未锁定），保证口径与自动分类完全一致。
 */
export function statusAfterRestore(task: ClassifiableTask, now = Date.now()): TaskStatus {
  return classifyStatus({ ...task, status: 'ongoing', statusLocked: false }, now)
}

/** 状态的中文名（界面与日志共用，保持唯一来源） */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  ongoing: '进行中',
  upcoming: '未开始',
  done: '已完成',
  expired: '已过期',
  deleted: '已删除'
}

/** 状态展示顺序（左侧类别栏的固定顺序；「已删除」排在最后） */
export const STATUS_ORDER: TaskStatus[] = ['ongoing', 'upcoming', 'done', 'expired', 'deleted']
