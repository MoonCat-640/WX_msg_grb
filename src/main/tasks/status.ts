/**
 * 任务状态分类与「实时重分类」调度
 * ------------------------------------------------------------------
 * 对应的需求：
 *   原版「模块 9」：初始化按起止时间分类；人工确认；运行中实时检测并重新标记
 *   更新需求 §4：新增「已删除」分类，且已删除的任务不参与时间自动分类
 *
 * 纯计算逻辑在 `classify.ts`（那边不依赖数据库，避免循环引用）；
 * 本文件只负责「遍历数据库里的任务并把新状态写回去」。
 */
import type { Task } from '@shared/types'
import { listUnlockedTasks, updateStatus } from '../data/task-repo'
import { scoped } from '../core/logger'

export {
  classifyStatus,
  statusAfterRestore,
  STATUS_LABEL,
  STATUS_ORDER,
  type ClassifiableTask
} from './classify'

import { classifyStatus } from './classify'

const log = scoped('task-status')

/**
 * 重新分类所有未锁定状态的任务。
 * 由定时器周期调用（默认每 30 秒一次），实现「实时检测并重新标记」。
 * 返回发生变化的条数与最新任务列表。
 */
export function reclassifyAll(now = Date.now()): { changed: number; tasks: Task[] } {
  const tasks = listUnlockedTasks()
  let changed = 0

  for (const t of tasks) {
    const next = classifyStatus(t, now)
    if (next !== t.status) {
      updateStatus(t.id, next)
      changed++
      log.info('任务状态自动更新', {
        任务: t.name,
        原状态: t.status,
        新状态: next,
        截止时间: t.endAt ? new Date(t.endAt).toISOString() : '未设置'
      })
    }
  }

  if (changed > 0) {
    log.info('状态自动分类完成', { 检查条数: tasks.length, 变更条数: changed })
  }
  return { changed, tasks }
}
