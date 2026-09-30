/**
 * 交互验收测试（jsdom）
 *
 * 覆盖需求文档「四十六、交互验收」里那条完整链路：
 *   选字数 → 生成答题格 → 打字 → 自动换行 → 数字规则 → 复制原文
 * 以及最关键的「中文输入法不能崩」。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { inkMetricsOf } from './cellGlyphs'
import { __setMetricsForTest } from './glyphMetrics'

// jsdom 没有 canvas，量不到真实墨迹。注入一套取自 Noto Serif SC 的实测值，
// 让「墨迹落在哪里」这类断言在测试里也有意义（真实浏览器是现场量的）。
__setMetricsForTest('serif', '。', { offsetXEm: -0.318, offsetYEm: 0.36, inkWidthEm: 0.28, inkHeightEm: 0.28 })

function setup() {
  const utils = render(<App />)
  const textarea = utils.container.querySelector('.editor-surface') as HTMLTextAreaElement
  expect(textarea).toBeTruthy()
  return { ...utils, textarea }
}

/** 取整个答题卡上所有格子的可见文字 */
function allCells(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.cell')).map((c) => c.textContent ?? '')
}

/** 取第一行的可见文字 */
function firstRow(container: HTMLElement): string[] {
  const row = container.querySelector('.grid-row')
  if (!row) return []
  return Array.from(row.querySelectorAll('.cell')).map((c) => c.textContent ?? '')
}

/** 模拟用户输入（走原生 input 事件链路） */
function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } })
}

function clickChip(label: string) {
  const button = screen.getAllByRole('button').find((b) => b.textContent?.trim().startsWith(label))
  expect(button, `找不到按钮：${label}`).toBeTruthy()
  fireEvent.click(button!)
}

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('答题卡初次渲染', () => {
  it('默认生成一张 A3 横向答题卡，并带模板装饰', () => {
    const { container } = setup()
    expect(container.querySelector('.sheet-page')).toBeTruthy()
    expect(screen.getByText('申论答题卡')).toBeTruthy()
    expect(container.querySelectorAll('.corner-mark')).toHaveLength(4)
    expect(container.querySelectorAll('.cell').length).toBeGreaterThan(0)
  })

  it('每行格数默认为 25', () => {
    const { container } = setup()
    expect(container.querySelector('.grid-row')?.querySelectorAll('.cell')).toHaveLength(25)
  })

  it('默认容量 300 格 = 12 行', () => {
    const { container } = setup()
    const panels = container.querySelectorAll('.panel')
    expect(panels.length).toBeGreaterThan(0)
    expect(panels[0].querySelectorAll('.grid-row')).toHaveLength(12)
  })
})

describe('交互验收：第一步到第六步', () => {
  it('选择 800 字后答题格自动重算（32 行 → 跨 2 个面板）', () => {
    const { container } = setup()
    clickChip('800')
    const rows = container.querySelectorAll('.grid-row')
    expect(rows.length).toBe(32)
    // 每个面板装不下 32 行 → 需要 2 个面板
    expect(container.querySelectorAll('.panel').length).toBe(2)
  })

  it('输入「当前，我国经济社会发展进入新阶段。」逐字进入方格', () => {
    const { container, textarea } = setup()
    type(textarea, '当前，我国经济社会发展进入新阶段。')
    const row = firstRow(container)
    expect(row.slice(2, 20).join('')).toBe('当前，我国经济社会发展进入新阶段。')
  })

  it('继续输入很多文字会自动换行', () => {
    const { container, textarea } = setup()
    clickChip('段首缩进2格') // 关掉段首缩进，本用例只关心折行
    type(textarea, '字'.repeat(45))
    const rows = container.querySelectorAll('.grid-row')
    const first = Array.from(rows[0].querySelectorAll('.cell')).map((c) => c.textContent)
    const second = Array.from(rows[1].querySelectorAll('.cell')).map((c) => c.textContent)
    expect(first.filter(Boolean)).toHaveLength(25)
    expect(second.filter(Boolean)).toHaveLength(20)
    expect(rows[1].querySelectorAll('.cell')[19].textContent).toBe('字')
    expect(rows[1].querySelectorAll('.cell')[20].textContent).toBe('')
  })

  it('输入 2026 按数字规则显示为 [20][26]', () => {
    const { container, textarea } = setup()
    type(textarea, '2026')
    const cells = allCells(container).filter(Boolean)
    expect(cells).toEqual(['20', '26'])
  })

  it('输入引号与省略号会自动处理', () => {
    const { container, textarea } = setup()
    type(textarea, '他说：“我们要加快建设……”')
    const cells = allCells(container).filter(Boolean)
    expect(cells).toContain('：“') // 冒号 + 开引号合占一格
    expect(cells.filter((c) => c === '…')).toHaveLength(2) // 省略号横跨两格
    expect(cells[cells.length - 1]).toBe('”')
  })

  it('统计条实时更新', () => {
    const { container, textarea } = setup()
    type(textarea, '你好世界')
    const stats = Array.from(container.querySelectorAll('.stat')).map((el) => el.textContent ?? '')
    expect(stats.some((t) => t.includes('已输入') && t.includes('4'))).toBe(true)
    expect(stats.some((t) => t.includes('已占') && t.includes('4'))).toBe(true)
  })
})

describe('中文输入法', () => {
  it('组合输入期间不提交模型，答题卡不显示拼音', () => {
    const { container, textarea } = setup()
    fireEvent.compositionStart(textarea)
    type(textarea, 'nihao')
    // 组合中：模型未更新
    expect(allCells(container).filter(Boolean)).toHaveLength(0)
  })

  it('组合结束才把最终汉字写入方格，且不重复不丢失', () => {
    const { container, textarea } = setup()
    fireEvent.compositionStart(textarea)
    type(textarea, 'nihao')
    type(textarea, '你好')
    fireEvent.compositionEnd(textarea)
    expect(allCells(container).filter(Boolean)).toEqual(['你', '好'])
  })

  it('连续两次组合输入互不干扰', () => {
    const { container, textarea } = setup()
    // 第一次上屏：第一
    fireEvent.compositionStart(textarea)
    type(textarea, 'diyi')
    type(textarea, '第一')
    fireEvent.compositionEnd(textarea)
    expect(allCells(container).filter(Boolean)).toEqual(['第', '一'])

    // 第二次上屏：在已有内容后面接着输入，组合中输入串不能泄漏到方格
    fireEvent.compositionStart(textarea)
    type(textarea, '第一dier')
    expect(allCells(container).filter(Boolean)).toEqual(['第', '一'])
    type(textarea, '第一第二')
    fireEvent.compositionEnd(textarea)
    expect(allCells(container).filter(Boolean)).toEqual(['第', '一', '第', '二'])
  })
})

/** 可见光标落在哪一格 */
function caretCell(container: HTMLElement): { row: number; col: number } | null {
  const caret = container.querySelector('.caret')
  if (!caret) return null
  const cell = caret.closest('[data-cell]') as HTMLElement | null
  if (!cell) return null
  return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }
}

describe('光标与选区的可见反馈', () => {
  it('文本没变、只移动光标时，可见光标必须跟着走', () => {
    const { container, textarea } = setup()
    clickChip('段首缩进2格') // 关掉缩进，列号好算
    type(textarea, '你好世界')

    textarea.setSelectionRange(4, 4)
    fireEvent.select(textarea)
    expect(caretCell(container)).toEqual({ row: 0, col: 4 })

    fireEvent.keyDown(textarea, { key: 'ArrowLeft' })
    expect(caretCell(container)).toEqual({ row: 0, col: 3 })

    fireEvent.keyDown(textarea, { key: 'ArrowLeft' })
    expect(caretCell(container)).toEqual({ row: 0, col: 2 })
  })

  it('点击答题格时可见光标随之移动', () => {
    const { container, textarea } = setup()
    clickChip('段首缩进2格')
    type(textarea, '你好世界')

    const cell = container.querySelectorAll('.grid-row')[0].querySelectorAll('.cell')[1] as HTMLElement
    fireEvent.pointerDown(cell, { clientX: 0 })
    expect(caretCell(container)).toEqual({ row: 0, col: 1 })
  })

  it('Shift+方向键扩展选区时出现高亮', () => {
    const { container, textarea } = setup()
    clickChip('段首缩进2格')
    type(textarea, '你好世界')

    textarea.setSelectionRange(0, 0)
    fireEvent.select(textarea)
    expect(container.querySelectorAll('.cell--selected')).toHaveLength(0)

    fireEvent.keyDown(textarea, { key: 'ArrowRight', shiftKey: true })
    expect(container.querySelectorAll('.cell--selected').length).toBeGreaterThan(0)
  })

  it('Shift+← 在已有选区上是缩回一格，而不是整块跳过', () => {
    const { textarea } = setup()
    clickChip('段首缩进2格')
    type(textarea, '你好世界')

    textarea.setSelectionRange(1, 3, 'forward')
    fireEvent.select(textarea)
    fireEvent.keyDown(textarea, { key: 'ArrowLeft', shiftKey: true })
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 2])
  })

  it('反向选区按 Shift+→ 也是缩回一格', () => {
    const { textarea } = setup()
    clickChip('段首缩进2格')
    type(textarea, '你好世界')

    textarea.setSelectionRange(0, 2, 'backward')
    fireEvent.select(textarea)
    fireEvent.keyDown(textarea, { key: 'ArrowRight', shiftKey: true })
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 2])
  })
})

describe('键盘编辑', () => {
  it('退格一次删掉整个破折号', () => {
    const { container, textarea } = setup()
    type(textarea, '发展——')
    expect(allCells(container).filter(Boolean)).toEqual(['发', '展', '—', '—'])

    textarea.setSelectionRange(4, 4)
    fireEvent.keyDown(textarea, { key: 'Backspace' })
    expect(textarea.value).toBe('发展')
  })

  it('方向键整体跨过破折号，不停在中间', () => {
    const { textarea } = setup()
    type(textarea, '发展——进步')
    textarea.setSelectionRange(4, 4)
    fireEvent.keyDown(textarea, { key: 'ArrowLeft' })
    expect(textarea.selectionStart).toBe(2)
  })

  it('复合标点退格一次只删一个字符，按输入顺序删', () => {
    const { textarea } = setup()
    clickChip('段首缩进2格')
    type(textarea, '好。”')
    expect(textarea.value).toBe('好。”')

    textarea.setSelectionRange(3, 3)
    fireEvent.keyDown(textarea, { key: 'Backspace' })
    expect(textarea.value).toBe('好。')

    fireEvent.keyDown(textarea, { key: 'Backspace' })
    expect(textarea.value).toBe('好')
  })

  it('Ctrl+A / Ctrl+C 不拦截，复制走原生链路', () => {
    const { textarea } = setup()
    type(textarea, '你好')
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
    textarea.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('段落格式', () => {
  it('粘贴多行文本会产生多个段落，并自动按正文样式排版', () => {
    const { container, textarea } = setup()
    clickChip('段首缩进2格') // 先关掉缩进，方便数行
    type(textarea, '第一段\n第二段\n第三段')
    expect(container.querySelectorAll('.grid-row').length).toBeGreaterThanOrEqual(3)

    const rows = Array.from(container.querySelectorAll('.grid-row'))
    const texts = rows.slice(0, 3).map((r) => Array.from(r.querySelectorAll('.cell')).map((c) => c.textContent).join(''))
    expect(texts[0]).toBe('第一段')
    expect(texts[1]).toBe('第二段')
    expect(texts[2]).toBe('第三段')
  })

  it('把光标所在段落设为标题后会居中，其余段落不受影响', () => {
    const { container, textarea } = setup()
    clickChip('段首缩进2格')
    type(textarea, '推动乡村振兴\n第一段正文')

    textarea.setSelectionRange(2, 2)
    fireEvent.select(textarea)
    clickChip('标题（居中）')

    const rows = Array.from(container.querySelectorAll('.grid-row'))
    const firstRowTexts = Array.from(rows[0].querySelectorAll('.cell')).map((c) => c.textContent)
    const secondRowTexts = Array.from(rows[1].querySelectorAll('.cell')).map((c) => c.textContent)
    // 标题居中：前面留白，后面留白
    expect(firstRowTexts[0]).toBe('')
    expect(firstRowTexts.findIndex((t) => t === '推')).toBeGreaterThan(0)
    // 正文段仍从行首开始
    expect(secondRowTexts[0]).toBe('第')
  })

  it('段首缩进开关作用到每一段正文', () => {
    const { container, textarea } = setup()
    type(textarea, '第一段\n第二段')
    const rows = Array.from(container.querySelectorAll('.grid-row'))
    for (const row of rows.slice(0, 2)) {
      const texts = Array.from(row.querySelectorAll('.cell')).map((c) => c.textContent)
      expect(texts[0]).toBe('')
      expect(texts[1]).toBe('')
      expect(texts[2]).toBe('第')
    }
  })
})

describe('复制文本', () => {
  it('复制到的是原始逻辑文本，不含方格与自动换行', async () => {
    const { textarea } = setup()
    type(textarea, '字'.repeat(45))
    clickChip('复制文本')
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('字'.repeat(45))
    })
  })
})

describe('示例答案', () => {
  it('填入示例后各类排版规则一眼可见', async () => {
    const { container } = setup()
    clickChip('填入示例')
    await waitFor(() => {
      const cells = allCells(container).filter(Boolean)
      // 数字两两成组
      expect(cells).toContain('20')
      expect(cells).toContain('26')
      // 复合标点
      expect(cells).toContain('：“')
      // 省略号横跨两格
      expect(cells.filter((c) => c === '…')).toHaveLength(2)
      // 破折号横跨两格
      expect(cells.filter((c) => c === '—')).toHaveLength(2)
      // 标题居中：第一行前面留白
      const firstRow = container.querySelector('.grid-row')!
      const firstCells = Array.from(firstRow.querySelectorAll('.cell'))
      expect(firstCells.findIndex((c) => c.textContent === '推')).toBeGreaterThan(0)
    })
  })

  it('填入示例可以撤销', async () => {
    const { container, textarea } = setup()
    clickChip('填入示例')
    await waitFor(() => expect(textarea.value).toContain('推动乡村振兴'))
    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(allCells(container).filter(Boolean)).toHaveLength(0))
  })
})

describe('超容量提示', () => {
  it('超出容量时给出红色提示且不截断输入', () => {
    const { container, textarea } = setup()
    clickChip('150')
    type(textarea, '字'.repeat(160))
    expect(textarea.value).toHaveLength(160)
    expect(screen.getByText(/已超出设定容量/)).toBeTruthy()
    expect(container.querySelectorAll('.cell--overflow').length).toBeGreaterThan(0)
  })
})

describe('整卷模式', () => {
  it('切换到整卷模式后出现五个题目区块', () => {
    const { container } = setup()
    clickChip('整卷模式')
    const headings = Array.from(container.querySelectorAll('.panel-heading')).map((h) => h.textContent ?? '')
    expect(headings.some((h) => h.includes('第一题'))).toBe(true)
    expect(headings.some((h) => h.includes('第五题'))).toBe(true)
  })
})

describe('答题卡版式结构', () => {
  it('页脚显示页码与「全卷到此结束」', () => {
    const { container } = setup()
    expect(container.querySelector('.page-no')?.textContent).toMatch(/第 1 页 \/ 共 \d+ 页/)
    expect(container.querySelector('.end-note')?.textContent).toBe('全卷到此结束')
  })

  it('四个黑色三角定位标记 + 中间竖向虚线 + 缺考/作弊区', () => {
    const { container } = setup()
    expect(container.querySelectorAll('.corner-mark')).toHaveLength(4)
    expect(container.querySelector('.sheet-body')).toBeTruthy() // ::before 画中间虚线
    expect(container.querySelector('.absent-box')?.textContent).toContain('缺考')
  })

  it('首页有抬头，续页换成「接上页」抬头', () => {
    const { container } = setup()
    expect(container.querySelector('.sheet-title')?.textContent).toBe('申论答题卡')
    expect(container.querySelector('.notice')?.textContent).toContain('注意事项')

    clickChip('1500') // 60 行 > 一页能放的行数 → 必然跨页
    const headers = Array.from(container.querySelectorAll('.sheet-header'))
    expect(headers.length).toBeGreaterThan(1)
    expect(headers[0].textContent).toContain('申论答题卡')
    // 续页抬头换成「接上页」，但姓名/准考证号与注意事项照样保留（把抬头填满，不压到答题区）
    expect(headers[0].textContent).not.toContain('接上页')
    expect(headers[1].textContent).toContain('接上页')
    expect(headers[1].textContent).toContain('注意事项')
    expect(headers[1].textContent).toContain('准考证号')
  })

  it('尺寸全部由 geometry.ts 注入的 CSS 变量推导，没有写死坐标', () => {
    const { container } = setup()
    const app = container.querySelector('.app') as HTMLElement
    expect(app.style.getPropertyValue('--cell')).toMatch(/mm$/)
    expect(app.style.getPropertyValue('--cols')).toBe('25')
    // 单题 300 字装得进一页 A4 → 纸张是 A4 纵向，不是 A3 横向
    expect(app.style.getPropertyValue('--page-w')).toBe('210mm')
    expect(app.style.getPropertyValue('--page-h')).toBe('297mm')

    // 改每行格数后，格边长跟着变（说明没有写死）
    const cellBefore = parseFloat(app.style.getPropertyValue('--cell'))
    const select = container.querySelector('select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: '35' } })
    expect(app.style.getPropertyValue('--cols')).toBe('35')
    expect(parseFloat(app.style.getPropertyValue('--cell'))).toBeLessThan(cellBefore)
  })
})

describe('自定义字数', () => {
  it('数字输入框可以填任意字数', () => {
    const { container } = setup()
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '250' } })
    // 250 格 = 10 行（每行 25 格）
    expect(container.querySelectorAll('.grid-row')).toHaveLength(10)
    const stats = Array.from(container.querySelectorAll('.stat')).map((el) => el.textContent ?? '')
    expect(stats.some((t) => t.includes('目标') && t.includes('250'))).toBe(true)
  })
})

describe('整卷模式：各题独立', () => {
  it('在 A 题输入不影响 B 题，切题保留各自内容', async () => {
    const { container, textarea } = setup()
    clickChip('整卷模式')
    type(textarea, '第一题作答')
    await waitFor(() => expect(allCells(container).filter(Boolean).join('')).toContain('第一题作答'))

    // 切到第二题：输入框应当清空
    clickChip('第二题')
    await waitFor(() => expect(textarea.value).toBe(''))
    type(textarea, '第二题作答')
    await waitFor(() => expect(textarea.value).toBe('第二题作答'))

    // 切回第一题：内容还在
    clickChip('第一题')
    await waitFor(() => expect(textarea.value).toBe('第一题作答'))
  })

  it('可以追加题目，新题自动编号并成为当前作答对象', async () => {
    const { container, textarea } = setup()
    clickChip('整卷模式')
    const before = container.querySelectorAll('.block-tabs .chip').length
    clickChip('＋ 添加题目')
    // 默认 5 题 + 添加/删除两个按钮 → 追加后 6 题
    expect(container.querySelectorAll('.block-tabs .chip').length).toBe(before + 1)
    expect(container.querySelector('.block-tabs')?.textContent).toContain('第六题')

    type(textarea, '第六题作答')
    await waitFor(() => expect(allCells(container).filter(Boolean).join('')).toContain('第六题作答'))
    // 新题有独立的答题区
    expect(container.querySelectorAll('.panel').length).toBeGreaterThanOrEqual(6)
  })

  it('可以删除当前题目，且至少保留一题', async () => {
    const { container } = setup()
    clickChip('整卷模式')
    clickChip('第三题')
    clickChip('－ 删除本题')
    await waitFor(() => {
      expect(container.querySelector('.block-tabs')?.textContent).not.toContain('第三题')
    })

    // 删到只剩一题后不再允许删
    for (let i = 0; i < 4; i++) clickChip('－ 删除本题')
    expect(container.querySelectorAll('.block-tabs .chip').length).toBe(3) // 1 题 + 添加 + 删除
    expect(screen.getByText(/至少要保留一道题/)).toBeTruthy()
  })

  it('复制整卷会把所有题目的原文都带上', async () => {
    const { textarea } = setup()
    clickChip('整卷模式')
    type(textarea, '第一题作答')
    clickChip('第二题')
    await waitFor(() => expect(textarea.value).toBe(''))
    type(textarea, '第二题作答')

    clickChip('复制整卷')
    await waitFor(() => {
      const copied = (navigator.clipboard.writeText as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]
      expect(copied).toContain('第一题作答')
      expect(copied).toContain('第二题作答')
    })
  })
})

describe('挤占的视觉位置', () => {
  it('被挤占进来的句号，墨迹落在格子的右下角', () => {
    const { container, textarea } = setup()
    clickChip('段首缩进2格')
    type(textarea, '字'.repeat(25) + '。')
    const attach = container.querySelector('.attach') as HTMLElement
    expect(attach).toBeTruthy()
    expect(attach.textContent).toBe('。')

    // DOM 里给的是元素中心（--gx / --gy），换算回「墨迹实际落在哪」
    const metrics = inkMetricsOf('。')
    const fontSize = 0.76 * 0.82 // glyphScale（一格标点）
    const boxX = parseFloat(attach.style.getPropertyValue('--gx'))
    const boxY = parseFloat(attach.style.getPropertyValue('--gy'))
    const inkX = boxX / 100 + metrics.offsetXEm * fontSize
    const inkY = boxY / 100 + metrics.offsetYEm * fontSize
    expect(inkX).toBeGreaterThan(0.65)
    expect(inkY).toBeGreaterThan(0.65)
  })
})

describe('标点的绘制位置', () => {
  it('独立占格的标点居中绘制，靠字体自身的墨迹位置，不再叠加偏移', () => {
    const { container, textarea } = setup()
    clickChip('段首缩进2格')
    type(textarea, '甲，乙。')
    const cells = container.querySelectorAll('.grid-row .cell')
    // 逗号在第 2 格、句号在第 4 格，都应当是普通居中字形
    for (const index of [1, 3]) {
      const glyph = cells[index].querySelector('.glyph') as HTMLElement
      expect(glyph).toBeTruthy()
      expect(glyph.textContent).toBe(index === 1 ? '，' : '。')
      expect(glyph.className).toBe('glyph')
      expect(glyph.getAttribute('style')).toBeNull()
    }
  })

  it('复合标点仍然按组合表分开放置（墨迹不重叠）', () => {
    const { container, textarea } = setup()
    clickChip('段首缩进2格')
    type(textarea, '好。”')
    const positioned = container.querySelectorAll('.glyph--positioned')
    expect(positioned).toHaveLength(2)
    const xs = Array.from(positioned).map((el) => parseFloat((el as HTMLElement).getAttribute('style')!.match(/--gx: ([\d.]+)/)![1]))
    // 句号在左下、闭引号在右上，两者的字身框位置必须分开
    expect(Math.abs(xs[0] - xs[1])).toBeGreaterThan(10)
  })
})

describe('行末格数标注', () => {
  it('空白答题卡上就印着固定的整百格标注（与写了多少字无关）', () => {
    const { container, textarea } = setup()
    clickChip('段首缩进2格')
    // 默认 300 格 = 12 行，25 格/行 → 第 4 / 8 / 12 行分别是 100 / 200 / 300
    const before = Array.from(container.querySelectorAll('.row-marker')).map((m) => m.textContent)
    expect(before).toEqual(['100', '200', '300'])

    type(textarea, '字'.repeat(137))
    const after = Array.from(container.querySelectorAll('.row-marker')).map((m) => m.textContent)
    expect(after).toEqual(['100', '200', '300'])
  })

  it('单题练习：装得进一页 A4 就用 A4 纵向，纸张缩小但格子不变', () => {
    const { container } = setup()
    // 300 格 ÷ 25 = 12 行，一页 A4 放得下 → 只用一个面板
    expect(container.querySelectorAll('.panel')).toHaveLength(1)
    const app = container.querySelector('.app') as HTMLElement
    expect(app.style.getPropertyValue('--page-w')).toBe('210mm')

    const panelWidth = parseFloat(app.style.getPropertyValue('--panel-w'))
    const contentWidth = parseFloat(app.style.getPropertyValue('--content-w'))
    expect(panelWidth).toBeCloseTo(contentWidth, 5) // 一栏铺满
    expect(panelWidth).toBeCloseTo(196, 5)

    // 单栏时不画中间那条竖向虚线
    expect(container.querySelector('.sheet-body--single')).toBeTruthy()
    // 行末标注排到右侧页边距里
    const rows = Array.from(container.querySelectorAll('.grid-row'))
    expect(rows[3].querySelector('.row-marker')?.className).toContain('row-marker--outer')
  })

  it('单题练习：装不下才回到 A3 两栏，且格子大小与 A4 时完全一致', () => {
    const { container } = setup()
    const app = container.querySelector('.app') as HTMLElement
    const cellA4 = parseFloat(app.style.getPropertyValue('--cell'))

    clickChip('800') // 32 行 > 一页 A4 能放的行数
    expect(app.style.getPropertyValue('--page-w')).toBe('420mm')
    expect(container.querySelectorAll('.panel').length).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('.sheet-body--single')).toBeNull()

    // 关键：换版式之后格子边长一点没变
    expect(parseFloat(app.style.getPropertyValue('--cell'))).toBeCloseTo(cellA4, 5)

    const leftMarker = Array.from(container.querySelectorAll('.grid-row'))
      .map((r) => r.querySelector('.row-marker'))
      .find((m) => m?.className.includes('row-marker--inset'))
    expect(leftMarker).toBeTruthy()
  })

  it('纸张说明跟着版式走（A4 纵向 / A3 横向）', () => {
    const { container } = setup()
    const caption = () => container.querySelector('.page-caption')?.textContent ?? ''
    expect(caption()).toContain('A4 纵向')
    expect(caption()).toContain('每行 25 格')

    clickChip('800') // 切到 A3 两栏
    expect(caption()).toContain('A3 横向')

    clickChip('整卷模式')
    expect(caption()).toContain('A3 横向')
  })

  it('A3 两栏版式下，即使某页只排得下 1 个答题区，中间虚线也还在', () => {
    const { container } = setup()
    clickChip('整卷模式')
    // 6 道题 → 3 页两栏 + 1 页单栏
    clickChip('＋ 添加题目')
    const bodies = Array.from(container.querySelectorAll('.sheet-body'))
    expect(bodies.length).toBeGreaterThan(2)
    // 两栏版式下每一页都要有虚线（.sheet-body--single 会把它隐藏）
    for (const body of bodies) {
      expect(body.className).not.toContain('sheet-body--single')
    }
  })

  it('工具栏按钮在 mousedown 时不抢焦点（否则点完按钮打字会丢字）', () => {
    const { container } = setup()
    const button = Array.from(container.querySelectorAll('.toolbar button')).find((b) =>
      b.textContent?.includes('800'),
    ) as HTMLButtonElement
    expect(button).toBeTruthy()
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)

    // 下拉框与复选框要照常可点，不能被拦
    const select = container.querySelector('.toolbar select') as HTMLSelectElement
    const selDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    select.dispatchEvent(selDown)
    expect(selDown.defaultPrevented).toBe(false)
  })

  it('整卷模式始终 A3 两栏', () => {
    const { container } = setup()
    clickChip('整卷模式')
    const app = container.querySelector('.app') as HTMLElement
    expect(app.style.getPropertyValue('--page-w')).toBe('420mm')
    expect(container.querySelector('.sheet-body--single')).toBeNull()
  })

  it('标注贴在对应那一行的行末', () => {
    const { container } = setup()
    const rows = Array.from(container.querySelectorAll('.grid-row'))
    expect(rows[3].querySelector('.row-marker')?.textContent).toBe('100')
    expect(rows[7].querySelector('.row-marker')?.textContent).toBe('200')
    expect(rows[0].querySelector('.row-marker')).toBeNull()
  })

  it('容量不足整百时，末尾不再额外补一个实时字数', () => {
    const { container } = setup()
    clickChip('150') // 6 行 = 150 格
    const markers = Array.from(container.querySelectorAll('.row-marker')).map((m) => m.textContent)
    expect(markers).toEqual(['100'])
  })
})

describe('模板开关', () => {
  it('关闭模板装饰后不再渲染三角定位与缺考标记', () => {
    const { container } = setup()
    fireEvent.click(screen.getByLabelText('隐藏模板装饰'))
    expect(container.querySelectorAll('.corner-mark')).toHaveLength(0)
    expect(container.querySelector('.absent-box')).toBeNull()
  })
})

describe('打印容器', () => {
  it('页面上常驻一个干净的打印容器，且不含方格', () => {
    const { container } = setup()
    const printRoot = container.querySelector('.print-root')
    expect(printRoot).toBeTruthy()
    expect(printRoot?.querySelector('.cell')).toBeNull()
  })

  it('打印容器必须在 .app 之外，否则打印时会被一起隐藏', () => {
    const { container } = setup()
    const printRoot = container.querySelector('.print-root')!
    expect(printRoot.closest('.app')).toBeNull()
  })

  it('导出 PDF 会把干净文字写进打印容器', async () => {
    const { container, textarea } = setup()
    type(textarea, '当前，我国经济社会发展进入新阶段。')
    clickChip('导出 PDF')
    await waitFor(() => {
      const printRoot = container.querySelector('.print-root')!
      expect(printRoot.textContent).toContain('当前，我国经济社会发展进入新阶段。')
      expect(printRoot.querySelector('.cell')).toBeNull()
    })
  })
})
