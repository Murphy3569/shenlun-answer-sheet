/**
 * 输入层的滚动行为（jsdom）
 *
 * 这里守的是一条很容易写反的规则：
 *   · 光标自己动了 → 把光标所在的格滚进视野（打字、方向键、点格子、切题都算）；
 *   · 用户自己滚了 → 只把输入层贴到光标格上，**绝不反向滚视口**。
 *
 * 第二条一旦写错，整卷模式（一屏放不下多张答题卡）下就成了「光标锁在哪儿就滚不到别处」——
 * 用户往下滚，同一帧又被拽回光标所在的格，永远只能看到一屏。
 *
 * jsdom 没有布局：getBoundingClientRect 一律返回 0×0，Element.prototype 上也没有
 * scrollIntoView。所以这里手工给元素喂矩形，并给 scrollIntoView 装一个探针。
 */

import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { EditorSurface } from './EditorSurface'

/** 滚动容器（.sheet-viewport）的框：工具栏下沿到窗口底 */
const PORT = { top: 116, bottom: 813, left: 0, right: 1024 }

const CELL_W = 26
const CELL_H = 26

function box(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

/** 光标格的矩形，每个用例自己摆 */
let cellRect = box(0, 0, CELL_W, CELL_H)
let scrollSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  scrollSpy = vi.fn()
  ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList?.contains('sheet-viewport')) {
      return box(PORT.top, PORT.left, PORT.right - PORT.left, PORT.bottom - PORT.top)
    }
    if (this.hasAttribute?.('data-cell')) return cellRect
    return box(0, 0, 0, 0)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
})

type Props = ComponentProps<typeof EditorSurface>

/** 复刻 App 的结构：滚动容器里放答题格，输入层是它的兄弟节点 */
function mount(overrides: Partial<Props> = {}) {
  const props: Props = {
    text: '',
    tokens: [],
    rows: [],
    blockId: 'b1',
    anchor: { row: 0, column: 0, fraction: 0 },
    caretOffset: 0,
    layoutKey: 'a4-single-35',
    enabled: true,
    onCommit: () => {},
    onSelectionChange: () => {},
    onUndo: () => {},
    onRedo: () => {},
    onFocusRequest: () => {},
    ...overrides,
  }
  const utils = render(
    <div className="app">
      <div className="sheet-viewport">
        <div className="grid" data-block="b1">
          <div className="cell" data-cell="1" data-row="0" data-col="0" />
          <div className="cell" data-cell="1" data-row="1" data-col="0" />
        </div>
      </div>
      <EditorSurface {...props} />
    </div>,
  )
  return {
    ...utils,
    textarea: utils.container.querySelector('.editor-surface') as HTMLTextAreaElement,
    /** 改一组 props 重新渲染，模拟「光标动了 / 界面重排」的下一次渲染 */
    set(next: Partial<Props>) {
      utils.rerender(
        <div className="app">
          <div className="sheet-viewport">
            <div className="grid" data-block="b1">
              <div className="cell" data-cell="1" data-row="0" data-col="0" />
              <div className="cell" data-cell="1" data-row="1" data-col="0" />
            </div>
          </div>
          <EditorSurface {...props} {...next} />
        </div>,
      )
    },
    scroll() {
      fireEvent.scroll(utils.container.querySelector('.sheet-viewport') as HTMLElement)
    },
  }
}

/** 走完一帧：滚动路径是 rAF 合并之后再量位置的 */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

describe('输入层与滚动', () => {
  it('用户滚动时只重新贴合输入层，绝不把光标格拽回视野', async () => {
    // 光标格被滚到视口下方很远：这正是整卷模式里翻到下一张答题卡的情形
    cellRect = box(2000, 100, CELL_W, CELL_H)
    const page = mount()
    scrollSpy.mockClear()

    page.scroll()
    await flushFrame()

    expect(scrollSpy).not.toHaveBeenCalled()
    // 但输入层必须已经重新贴好，否则输入法候选框会留在旧位置
    expect(page.textarea.style.left).toBe('100px')
    expect(page.textarea.style.top).toBe('760px')
  })

  it('光标格在视口下方时，反复滚动都不会被拽回', async () => {
    cellRect = box(2000, 100, CELL_W, CELL_H)
    const page = mount()
    scrollSpy.mockClear()

    for (let i = 0; i < 5; i++) {
      page.scroll()
      await flushFrame()
    }

    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('光标真的换了一格时，把它滚进视野（原有行为不能丢）', async () => {
    cellRect = box(2000, 100, CELL_W, CELL_H)
    const page = mount()
    scrollSpy.mockClear()

    // 方向键下移一格：anchor 与 offset 同时变化
    page.set({ anchor: { row: 1, column: 0, fraction: 0 }, caretOffset: 1 })
    await flushFrame()

    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })

  it('anchor 投影相同、offset 变了（数字成组那种）也要滚进视野', async () => {
    // 2026 排成 [20][26]：两个 offset 落在同一格、格内比例也相同，
    // 只看 anchor 会以为光标没动，那次按键就永远不生效。
    const anchor = { row: 0, column: 0, fraction: 0 }
    cellRect = box(2000, 100, CELL_W, CELL_H)
    const page = mount({ anchor, caretOffset: 1 })
    scrollSpy.mockClear()

    page.set({ anchor, caretOffset: 2 })
    await flushFrame()

    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })

  it('光标格本来就在滚动容器里时不滚', async () => {
    cellRect = box(300, 100, CELL_W, CELL_H)
    const page = mount()
    scrollSpy.mockClear()

    page.set({ anchor: { row: 1, column: 0, fraction: 0 }, caretOffset: 1 })
    await flushFrame()

    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('被工具栏盖住的格也算看不见（判定要用滚动容器，不是 window）', async () => {
    // top=50 落在 window 里（0..768），但滚动容器从 116 才开始 —— 这一格其实被工具栏挡着。
    // 拿 window.innerHeight 判定会把它当成可见，光标就再也滚不回来。
    cellRect = box(50, 100, CELL_W, CELL_H)
    const page = mount()
    scrollSpy.mockClear()

    page.set({ anchor: { row: 1, column: 0, fraction: 0 }, caretOffset: 1 })
    await flushFrame()

    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })
})
