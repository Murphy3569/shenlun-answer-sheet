/**
 * 回归测试：两个会「静默毁数据」的 bug
 *
 * 共同点都不是崩溃，而是**把 A 的文本写进 B** —— 用户看不见，直到发现答案变了。
 * 这一类 bug 靠手点很难稳定复现，所以固化在这里。
 */

import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { __setMetricsForTest } from './glyphMetrics'

__setMetricsForTest('serif', '。', { offsetXEm: -0.318, offsetYEm: 0.36, inkWidthEm: 0.28, inkHeightEm: 0.28 })

function setup() {
  const utils = render(<App />)
  const textarea = utils.container.querySelector('.editor-surface') as HTMLTextAreaElement
  expect(textarea).toBeTruthy()
  return { ...utils, textarea }
}

/**
 * 点工具栏按钮。
 * 只在本用例自己的容器里找 —— 用 screen 全局查询会搜到同文件里别的用例残留的容器，
 * 点到另一个 App 实例上，行为诡异且极难查。
 */
function clickChip(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith(label),
  )
  expect(button, `找不到按钮：${label}`).toBeTruthy()
  fireEvent.click(button!)
}

function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } })
}

/** 取某一道题答题区里显示的原文 */
function blockText(container: HTMLElement, title: string): string {
  const grid = Array.from(container.querySelectorAll<HTMLElement>('.grid[data-block]')).find((g) =>
    (g.dataset.block ?? '').includes(title),
  )
  if (!grid) return ''
  return Array.from(grid.querySelectorAll('.cell'))
    .map((c) => c.textContent ?? '')
    .join('')
}

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  // 删有内容的题目 / 切模式都会弹确认框，jsdom 里没有任何实现，不 stub 的话操作会被静默取消
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('删题之后撤销，不能污染另一道题', () => {
  it('撤销弹出一道已删题目的快照时，它的文本不得被提交给当前这道题', async () => {
    const { container, textarea } = setup()
    clickChip(container, '整卷模式')

    // 第二题写点东西，作为「不能被覆盖」的对照
    clickChip(container, '第二题')
    type(textarea, '第二题的答案')
    await waitFor(() => expect(blockText(container, '第二题')).toContain('第二题的答案'))

    // 切到第一题，**分两次输入、中间跨过 600ms 的合并窗口** ——
    // 这样栈顶才会是一份「文字非空」的快照。只输入一次的话快照记的是空串，
    // 撤销写回的也是空串，bug 就看不出来了。
    clickChip(container, '第一题')
    await new Promise((resolve) => setTimeout(resolve, 700))
    type(textarea, '第一题')
    await waitFor(() => expect(blockText(container, '第一题')).toContain('第一题'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    type(textarea, '第一题的答案')
    await waitFor(() => expect(blockText(container, '第一题')).toContain('第一题的答案'))

    // 删掉第一题 —— 它的快照就此变成「指向一道不存在的题」
    clickChip(container, '－ 删除本题')
    await waitFor(() => expect(container.querySelector('.block-tabs')?.textContent).not.toContain('第一题'))

    // 撤销之后再打一个字：修复前这一下会把「第一题的答案」写进第二题
    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    type(textarea, `${textarea.value}X`)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const second = blockText(container, '第二题')
    expect(second, `第二题被写成了「${second}」`).not.toContain('第一题')
  })
})

describe('删除中间一题后再添加，题号不能撞车', () => {
  it('新题接在最大题号后面，而不是按块数取号', async () => {
    const { container } = setup()
    clickChip(container, '整卷模式')
    clickChip(container, '第三题')
    clickChip(container, '－ 删除本题')
    await waitFor(() => expect(container.querySelector('.block-tabs')?.textContent).not.toContain('第三题'))

    clickChip(container, '＋ 添加题目')
    await waitFor(() => expect(container.querySelector('.block-tabs')?.textContent).toContain('第六题'))

    // 题号会进入「复制整卷」和 Word/PDF 导出的小标题，撞号之后两道题就分不出来了
    const tabs = container.querySelector('.block-tabs')?.textContent ?? ''
    for (const name of ['第一题', '第二题', '第四题', '第五题', '第六题']) {
      expect(tabs.split(name).length - 1, `「${name}」出现了不止一次：${tabs}`).toBe(1)
    }
  })
})

describe('打完字紧接着点工具栏，撤销要能分开退', () => {
  it('撤销一次只退掉工具栏那个动作，刚打的字要还在', async () => {
    const { container, textarea } = setup()
    type(textarea, '甲乙丙')
    await waitFor(() => expect(blockText(container, '第一题')).toContain('甲乙丙'))

    // 立刻点工具栏（在 600ms 合并窗口之内）
    clickChip(container, '标题（居中）')
    await new Promise((resolve) => setTimeout(resolve, 30))

    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(blockText(container, '第一题'), '第一次撤销把刚打的字也撤掉了').toContain('甲乙丙')

    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(blockText(container, '第一题')).not.toContain('甲乙丙')
  })
})

describe('Shift+点格建立的反向选区', () => {
  it('接着按 Shift+← 应该往左扩，而不是从右边把选区吃掉', async () => {
    const { container, textarea } = setup()
    clickChip(container, '段首缩进2格') // 关掉缩进，格号与 offset 对齐
    type(textarea, '字'.repeat(10))
    await waitFor(() => expect(blockText(container, '第一题')).toContain('字'))

    // 点格定位走的是 requestAnimationFrame，等一帧以上再断言
    const cells = container.querySelectorAll('.grid-row')[0].querySelectorAll('.cell')
    const caretInfo = () => {
      const c = container.querySelector('.cell--caret') as HTMLElement | null
      return c ? `${c.dataset.row}/${c.dataset.col}` : 'none'
    }
    console.log('DBG caretBefore=' + caretInfo() + ' taValue=' + JSON.stringify(textarea.value) + ' textAreaCount=' + container.querySelectorAll('.editor-surface').length)
    fireEvent.pointerDown(cells[10], { clientX: 0 })
    for (const ms of [0, 5, 20, 60]) {
      await new Promise((resolve) => setTimeout(resolve, ms))
    }
    fireEvent.pointerDown(cells[5], { clientX: 0, shiftKey: true })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([5, 10])
    expect(textarea.selectionDirection).toBe('backward')

    fireEvent.keyDown(textarea, { key: 'ArrowLeft', shiftKey: true })
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([4, 10])
  })
})

describe('输入法组合期间切题，不能把上一题的文本提交给新题', () => {
  it('组合中点另一道题，上屏时不得覆盖那道题已有的作答', async () => {
    const { container, textarea } = setup()
    clickChip(container, '整卷模式')

    clickChip(container, '第一题')
    type(textarea, '第一题作答')
    await waitFor(() => expect(blockText(container, '第一题')).toContain('第一题作答'))

    clickChip(container, '第二题')
    type(textarea, '第二题作答')
    await waitFor(() => expect(blockText(container, '第二题')).toContain('第二题作答'))

    // 回到第一题，用拼音输入法开始打字：预编辑没上屏，textarea 里是「第一题作答 + nihao」
    clickChip(container, '第一题')
    await waitFor(() => expect(textarea.value).toBe('第一题作答'))
    fireEvent.compositionStart(textarea)
    textarea.value = '第一题作答nihao'

    // 组合还没结束就切到第二题
    clickChip(container, '第二题')

    // 输入法上屏
    fireEvent.compositionEnd(textarea)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const second = blockText(container, '第二题')
    expect(second, `第二题被写成了「${second}」`).toBe('第二题作答')
  })
})
