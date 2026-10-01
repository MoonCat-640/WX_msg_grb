/**
 * 磁贴布局仓储
 * ------------------------------------------------------------------
 * 需求：「磁贴可以拖动，但放置有网格（类似 Windows10 开始菜单动态磁贴的交互方式）」
 * 用户拖拽后的 (列, 行) 位置存在这里；未记录位置的磁贴由界面按空闲格自动排布。
 */
import type { TileLayout, TaskStatus } from '@shared/types'
import { execute, query, transaction } from '../core/store'

export function getLayouts(): TileLayout[] {
  const rows = query<{ task_id: string; status: string; col: number; row: number }>(
    'SELECT * FROM tile_layouts'
  )
  return rows.map((r) => ({
    taskId: r.task_id,
    status: r.status as TaskStatus,
    col: r.col,
    row: r.row
  }))
}

/** 整体替换布局（界面拖拽结束后一次性提交） */
export function setLayouts(layouts: TileLayout[]): TileLayout[] {
  transaction(() => {
    execute('DELETE FROM tile_layouts')
    for (const l of layouts) {
      execute('INSERT INTO tile_layouts (task_id, status, col, row) VALUES (?,?,?,?)', [
        l.taskId,
        l.status,
        l.col,
        l.row
      ])
    }
  })
  return getLayouts()
}

export function removeLayout(taskId: string): void {
  execute('DELETE FROM tile_layouts WHERE task_id = ?', [taskId])
}

export function clearLayouts(): void {
  execute('DELETE FROM tile_layouts')
}
