/**
 * 答题卡几何与分页测试
 *
 * 视觉验收的基础：格子必须是正方形、每页行数要算对、A3 尺寸要放得下，
 * 而且改「每行格数」时这些推导要跟着变，不能有写死的坐标。
 */

import { describe, expect, it } from 'vitest'
import { PANEL_WIDTH_MM, chooseLayout, computeGeometry, geometryToCssVars } from './geometry'
import { paginateBlocks, layoutBlock } from '../layout/layoutEngine'
import { createDefaultProfile, withProfile } from '../layout/profile'
import { createFullPaper } from '../document/model'
import type { BlockLayoutResult } from '../layout/types'

const profile = withProfile(createDefaultProfile(), { autoIndentFirstLine: false })

function layout(blockId: string, capacity: number, text = ''): BlockLayoutResult {
  return layoutBlock({ blockId, blockTitle: blockId, text, capacity }, profile)
}

describe('A3 横向页面几何', () => {
  it('页面是 420 × 297 mm（A3 横向）', () => {
    const geo = computeGeometry({ columns: 20, layout: 'a3-split' })
    expect([geo.pageWidth, geo.pageHeight]).toEqual([420, 297])
  })

  it('格子是正方形', () => {
    const geo = computeGeometry({ columns: 20, layout: 'a3-split' })
    // 边长由「面板宽度 ÷ 每行格数」反推，所以横竖一定相等
    expect(geo.cell).toBeCloseTo(geo.panelWidth / geo.columns, 10)
  })

  it('左右两个面板正好铺满页面内容宽度', () => {
    const geo = computeGeometry({ columns: 20, layout: 'a3-split' })
    expect(geo.panelWidth * 2 + geo.panelGap).toBeCloseTo(geo.contentWidth, 10)
  })

  it('面板高度装得下算出来的行数，且不会溢出页面', () => {
    const geo = computeGeometry({ columns: 20, layout: 'a3-split' })
    for (const pageIndex of [0, 1, 5]) {
      const rows = geo.rowsForPage(pageIndex)
      const used = rows * geo.cell + geo.panelHeading
      expect(used, `第 ${pageIndex} 页放不下`).toBeLessThanOrEqual(geo.panelHeight(pageIndex) + 1e-9)
    }
  })

  it('首页与续页行数相同 —— 每页都是 24 行（600 格）', () => {
    for (const layout of ['a3-split', 'a4-single'] as const) {
      const geo = computeGeometry({ columns: 25, layout })
      expect(geo.rowsForPage(0), `${layout} 首页`).toBe(24)
      expect(geo.rowsForPage(1), `${layout} 续页`).toBe(24)
      expect(geo.rowsForPage(7), `${layout} 第 8 页`).toBe(24)
    }
  })

  it('改每行格数时，格子边长随之变化（没有写死坐标）', () => {
    const a = computeGeometry({ columns: 15 })
    const b = computeGeometry({ columns: 30 })
    expect(a.cell).toBeGreaterThan(b.cell)
    expect(b.cell * 30).toBeCloseTo(b.panelWidth, 10)
  })

  it('通栏模式下单个面板占满整幅内容宽度', () => {
    const geo = computeGeometry({ columns: 20, layout: 'a4-single' })
    expect(geo.panelWidth).toBeCloseTo(geo.contentWidth, 10)
    expect(geo.cell).toBeCloseTo(geo.contentWidth / 20, 10)
  })

  it('导出的 CSS 变量覆盖全部尺寸，且都带单位', () => {
    const geo = computeGeometry({ columns: 20, layout: 'a3-split' })
    const vars = geometryToCssVars(geo)
    for (const key of ['--page-w', '--page-h', '--cell', '--panel-w', '--panel-gap']) {
      expect(vars[key], key).toMatch(/mm$/)
    }
    expect(vars['--cols']).toBe('20')
  })
})

describe('版式选择：格子大小不变，缩小的只是纸张', () => {
  it('两种版式的栏宽与格子边长完全一致（这是「格子大小不变」的保证）', () => {
    const a3 = computeGeometry({ columns: 25, layout: 'a3-split' })
    const a4 = computeGeometry({ columns: 25, layout: 'a4-single' })
    expect(a3.panelWidth).toBeCloseTo(a4.panelWidth, 10)
    expect(a3.cell).toBeCloseTo(a4.cell, 10)
    // 换每行格数同样成立
    for (const columns of [20, 30, 35]) {
      const a = computeGeometry({ columns, layout: 'a3-split' })
      const b = computeGeometry({ columns, layout: 'a4-single' })
      expect(a.cell, `columns=${columns}`).toBeCloseTo(b.cell, 10)
    }
  })

  it('内容永远不溢出纸张（必须扣掉页面边框与 .sheet-body 的上内边距）', () => {
    // 这两个数值写在 sheet.css 里，几何必须同步扣掉，否则续页的网格会顶出纸张下沿
    const BORDER = 0.6
    const BODY_PADDING_TOP = 2
    for (const columns of [20, 25, 30, 35]) {
      for (const layout of ['a3-split', 'a4-single'] as const) {
        const geo = computeGeometry({ columns, layout })

        const realContentWidth = geo.pageWidth - BORDER * 2 - geo.padding * 2
        const panelsWidth = geo.panelWidth * geo.panelsPerPage + geo.panelGap * (geo.panelsPerPage - 1)
        expect(panelsWidth, `${layout} columns=${columns} 横向溢出`).toBeLessThanOrEqual(realContentWidth + 1e-9)

        for (const pageIndex of [0, 1, 7]) {
          const header = geo.headerFirst
          const used =
            BORDER * 2 +
            geo.padding * 2 +
            header +
            geo.footer +
            BODY_PADDING_TOP +
            geo.panelHeading +
            geo.rowsForPage(pageIndex) * geo.cell
          expect(
            used,
            `${layout} columns=${columns} 第 ${pageIndex} 页纵向溢出 ${(used - geo.pageHeight).toFixed(2)}mm`,
          ).toBeLessThanOrEqual(geo.pageHeight + 1e-9)
        }
      }
    }
  })

  it('每行 25 格时，一页 A4 正好 600 格（24 行）', () => {
    const geo = computeGeometry({ columns: 25, layout: 'a4-single' })
    expect(geo.rowsForPage(0)).toBe(24)
    expect(geo.rowsForPage(0) * 25).toBe(600)
    // 而且不能只是「凑巧 floor 到 24」—— 余量要小于一个格高，否则就该再放一行
    const slack = geo.panelHeight(0) - geo.panelHeading - geo.rowsForPage(0) * geo.cell
    expect(slack).toBeGreaterThanOrEqual(0)
    expect(slack).toBeLessThan(geo.cell)
  })

  it('A4 纵向只有一栏、页面明显更窄；A3 横向两栏', () => {
    const a3 = computeGeometry({ columns: 25, layout: 'a3-split' })
    const a4 = computeGeometry({ columns: 25, layout: 'a4-single' })
    expect(a3.panelsPerPage).toBe(2)
    expect(a4.panelsPerPage).toBe(1)
    expect(a4.pageWidth).toBeCloseTo(210, 5) // A4 纵向
    expect(a3.pageWidth).toBeCloseTo(420, 5) // A3 横向
    expect(a4.pageHeight).toBeCloseTo(a3.pageHeight, 5)
    expect(a4.contentWidth).toBeCloseTo(a4.panelWidth, 10) // 一栏铺满内容宽度
  })

  it('单题练习：装得进一页 A4 就用 A4', () => {
    const a4 = computeGeometry({ columns: 25, layout: 'a4-single' })
    expect(chooseLayout(25, a4.rowsForPage(0), 'single')).toBe('a4-single')
    expect(chooseLayout(25, a4.rowsForPage(0) - 1, 'single')).toBe('a4-single')
    expect(chooseLayout(25, 0, 'single')).toBe('a4-single')
  })

  it('单题练习：装不下就回到 A3 两栏', () => {
    const a4 = computeGeometry({ columns: 25, layout: 'a4-single' })
    expect(chooseLayout(25, a4.rowsForPage(0) + 1, 'single')).toBe('a3-split')
    expect(chooseLayout(25, 40, 'single')).toBe('a3-split')
  })

  it('整卷模式始终 A3 两栏', () => {
    expect(chooseLayout(25, 1, 'full')).toBe('a3-split')
    expect(chooseLayout(25, 100, 'full')).toBe('a3-split')
  })

  it('每行格数变了也不会让两种版式的格子大小分叉', () => {
    for (const columns of [20, 25, 30, 35]) {
      const a3 = computeGeometry({ columns, layout: 'a3-split' })
      const a4 = computeGeometry({ columns, layout: 'a4-single' })
      expect(a3.cell).toBeCloseTo(PANEL_WIDTH_MM / columns, 10)
      expect(a4.cell).toBeCloseTo(PANEL_WIDTH_MM / columns, 10)
    }
  })
})

describe('分页', () => {
  const geo = computeGeometry({ columns: 20, layout: 'a3-split' })
  const options = { panelsPerPage: geo.panelsPerPage, rowsPerPanelForPage: geo.rowsForPage }

  it('容量不足一个面板时只占一个面板', () => {
    const block = layout('a', 300) // 15 行
    const { pages, panels } = paginateBlocks([block], profile, options)
    expect(panels).toHaveLength(1)
    expect(pages).toHaveLength(1)
    expect(panels[0].slot).toBe(0)
  })

  it('题目独占面板：两道题不会挤进同一个面板', () => {
    const { panels } = paginateBlocks([layout('a', 100), layout('b', 100)], profile, options)
    expect(panels).toHaveLength(2)
    expect(panels[0].blockId).toBe('a')
    expect(panels[1].blockId).toBe('b')
    expect(panels[0].pageIndex).toBe(0)
    expect(panels[1].pageIndex).toBe(0)
    expect(panels[0].slot).toBe(0)
    expect(panels[1].slot).toBe(1)
  })

  it('超长题目顺延到后续面板并标记为续页', () => {
    const rowsPerPanel = geo.rowsForPage(0)
    const block = layout('big', 800) // 800 ÷ 20 = 40 行
    const { panels } = paginateBlocks([block], profile, options)
    expect(panels.length).toBe(Math.ceil(40 / rowsPerPanel))
    expect(panels[0].isContinuation).toBe(false)
    expect(panels.slice(1).every((p) => p.isContinuation)).toBe(true)
    // 内容一行不少，且每个面板都不超过容量
    expect(panels.reduce((n, p) => n + p.rows.length, 0)).toBe(40)
    expect(panels.every((p) => p.rows.length <= rowsPerPanel)).toBe(true)
  })

  it('整卷模式：五道题按面板顺序铺开，题与题不共面板', () => {
    const blocks = createFullPaper().map((b) => layout(b.title, b.capacity))
    const { panels, pages } = paginateBlocks(blocks, profile, options)
    const rowsPerPanel = geo.rowsForPage(0)
    const expected = ['第一题', '第二题', '第三题', '第四题', '第五题']
      .flatMap((title, i) => {
        const capacity = [200, 200, 300, 400, 1000][i]
        const needed = Math.ceil(Math.ceil(capacity / 20) / rowsPerPanel)
        return Array.from({ length: needed }, () => title)
      })
    expect(panels.map((p) => p.blockTitle)).toEqual(expected)
    // 题目之间不共面板：每个题目的面板必须是连续一段
    const firstIndexOf = new Map<string, number>()
    panels.forEach((p, i) => {
      if (!firstIndexOf.has(p.blockTitle)) firstIndexOf.set(p.blockTitle, i)
    })
    expect([...firstIndexOf.values()]).toEqual([...firstIndexOf.values()].slice().sort((a, b) => a - b))
    expect(pages[0].kind).toBe('first')
    expect(pages[1].kind).toBe('continuation')
  })

  it('行的分页字段被正确回填', () => {
    const block = layout('big', 800)
    const { panels } = paginateBlocks([block], profile, options)
    expect(block.rows[0].panelIndex).toBe(0)
    expect(block.rows[0].pageIndex).toBe(0)
    expect(block.rows[0].isContinuation).toBe(false)
    const secondPanelFirstRow = panels[1].rows[0]
    expect(secondPanelFirstRow.isContinuation).toBe(true)
    expect(secondPanelFirstRow.rowInPanel).toBe(0)
  })

  it('空题目不会产生空面板', () => {
    const { panels } = paginateBlocks([layout('empty', 0)], profile, options)
    expect(panels).toHaveLength(1)
    expect(panels[0].rows.length).toBeGreaterThan(0)
  })

  it('分页不改动任何行内容（自动换行不污染原文）', () => {
    const block = layout('a', 400, '字'.repeat(500))
    const before = block.rows.map((r) => r.cells.map((c) => c.display).join(''))
    paginateBlocks([block], profile, options)
    const after = block.rows.map((r) => r.cells.map((c) => c.display).join(''))
    expect(after).toEqual(before)
    expect(block.text).toBe('字'.repeat(500))
  })
})
