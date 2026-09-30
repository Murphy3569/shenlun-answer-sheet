/**
 * 输入层（隐藏的原生 textarea）
 *
 * 这是「中文输入法必须正常」这条硬要求的落点。
 *
 * 做法：屏幕上渲染的是自绘的方格，但**真正的输入始终发生在一个原生 textarea 里**。
 * textarea 不可见、不接收鼠标事件，但它是真实可聚焦的表单元素，
 * 所以搜狗 / 微软拼音 / macOS 拼音的预编辑、候选、联想全部走浏览器原生逻辑，
 * 不存在「输入半个汉字就被重新排版」的问题。
 *
 * 三条铁律：
 *   1. 组合输入（composition）期间**绝不**写 textarea.value，也不提交模型；
 *   2. 方向键 / 退格 / 删除只做「按 Token 对齐」的修正，其余按键一律不拦；
 *   3. Ctrl/⌘ 组合键全部放行给浏览器（复制粘贴走原生，拷出来天然就是原文）。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  backspaceRange,
  caretPositionFor,
  deleteRange,
  nextStop,
  normalizeText,
  offsetForCellPoint,
  prevStop,
  snapOffset,
} from '../layout'
import type { Row, Token } from '../layout'

export interface EditorSurfaceHandle {
  /** 聚焦并把光标放到指定 offset；backward = 选区锚点在右端（shift+点格点到锚点左边就是这种） */
  focusAt(offset: number, end?: number, backward?: boolean): void
  /** 从外部改写文本（撤销、重置）并同步光标 */
  setValue(text: string, caret: number): void
  getElement(): HTMLTextAreaElement | null
  isFocused(): boolean
}

export interface CaretAnchor {
  row: number
  column: number
  fraction: number
}

interface EditorSurfaceProps {
  text: string
  tokens: Token[]
  rows: Row[]
  /** 当前答题块 id，用于在 DOM 里定位光标所在的格 */
  blockId: string
  /** 光标所在的格与格内位置 —— 输入层要贴着它，输入法候选框才会出现在光标旁边 */
  anchor: CaretAnchor
  /**
   * 光标在文本里的 offset。
   *
   * 这个值是 anchor 的**来源**，不是它的重复：anchor 是 offset 的有损投影，
   * 数字两两成组（2026 → [20][26]）、复合标点共格时，相邻两个 offset 会投到同一格。
   * 所以「光标动没动」只能看 offset —— 只看 anchor 会漏掉这几次按键。
   */
  caretOffset: number
  /** 版式标识：换纸张/换格数后位置会变，输入层必须重新贴合 */
  layoutKey: string
  /** 是否处于可编辑状态（未激活的答题块不接收输入） */
  enabled: boolean
  onCommit: (text: string, caret: number) => void
  onSelectionChange: (start: number, end: number) => void
  onUndo: () => void
  onRedo: () => void
  onFocusRequest: () => void
}

export const EditorSurface = forwardRef<EditorSurfaceHandle, EditorSurfaceProps>(function EditorSurface(
  { text, tokens, rows, blockId, anchor, caretOffset, layoutKey, enabled, onCommit, onSelectionChange, onUndo, onRedo, onFocusRequest },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)
  const [composing, setComposing] = useState(false)

  const latest = useRef({ tokens, rows })
  latest.current = { tokens, rows }

  const emitSelection = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    onSelectionChange(ta.selectionStart, ta.selectionEnd)
  }, [onSelectionChange])

  /**
   * textarea 里装的文本属于哪一道题。
   *
   * 组合输入期间不能写 textarea.value（铁律 1），所以用户在这期间切题时，
   * 输入层里留着的仍是上一题的文本 + 这次的拼音预编辑。
   * 记住它属于哪道题，提交时一对不上就丢弃 —— 否则 compositionend 会把
   * 上一题的整段文本提交给刚切过去的那道题，把它的作答整段覆盖掉。
   */
  const valueBlockRef = useRef(blockId)

  const commitFromTextarea = useCallback(
    (caretOverride?: number) => {
      const ta = taRef.current
      if (!ta) return
      // 输入层里的内容不属于当前这道题（组合期间切了题）：
      // 这一笔绝不能提交，只把输入层重新同步到当前题。
      // 丢掉的只是没上屏的预编辑，当前题已有的作答不受影响。
      if (valueBlockRef.current !== blockId) {
        ta.value = text
        valueBlockRef.current = blockId
        return
      }
      const raw = ta.value
      const normalized = normalizeText(raw)
      let caret = caretOverride ?? ta.selectionStart
      if (normalized !== raw) {
        // 归一化改动了内容（\r、零宽字符），要同步回 textarea 并修正光标
        const removed = raw.length - normalized.length
        ta.value = normalized
        caret = Math.max(0, caret - removed)
        ta.setSelectionRange(caret, caret)
      }
      onCommit(normalized, caret)
    },
    [blockId, onCommit, text],
  )

  // 让隐藏输入层贴着光标所在的格。
  // 这不是为了好看 —— 中文输入法的候选框是跟着输入元素的插入符走的，
  // 如果输入层永远钉在页面左上角，打字时候选框就会飘在屏幕角落。
  // 滚动、缩放、切版式之后位置都会变，所以要用捕获式 scroll 监听重新贴合。
  //
  // 关键：「把输入层贴过去」和「把光标滚进视野」是两件事，必须分开。
  // 前者任何时候都要做（滚动时不补，输入法候选框就留在旧位置）；
  // 后者只能由光标自己移动来触发 —— 一旦让 scroll 事件也能触发它，
  // 用户往哪边滚都会被同一帧拽回光标所在的格，而整卷模式一屏放不下多张答题卡，
  // 结果就是「光标锁在哪儿就滚不到别处」。所以滚动只贴合，不反向滚视口。
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return

    // revealCaret 只由「光标自己动了」的调用点为 true；滚动 / 改窗口大小一律 false。
    const position = (revealCaret: boolean) => {
      const selector = `[data-block="${CSS.escape(blockId)}"] [data-row="${anchor.row}"][data-col="${anchor.column}"]`
      const cell = document.querySelector(selector) as HTMLElement | null
      if (!cell) return
      let rect = cell.getBoundingClientRect()

      if (revealCaret) {
        // 参照物是真正的滚动容器 .sheet-viewport，不是 window：
        // 视口上沿在工具栏下面，拿 window.innerHeight 去比，
        // 会把「已经被工具栏盖住的格」当成可见，光标就永远滚不回来。
        // 比的也是光标那一点（格内 fraction 处）而不是整格，免得为了半格多滚一次。
        const port = cell.closest('.sheet-viewport')?.getBoundingClientRect()
        const caretX = rect.left + rect.width * anchor.fraction
        const caretY = rect.top + rect.height / 2
        if (port && (caretY < port.top || caretY > port.bottom || caretX < port.left || caretX > port.right)) {
          // nearest：已经在视野内就什么都不做
          cell.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          // 滚完位置就变了，重新量一次，输入层才能一步贴到滚动后的位置（否则候选框慢一帧）
          rect = cell.getBoundingClientRect()
        }
      }

      const x = rect.left + rect.width * anchor.fraction
      const y = rect.top + rect.height / 2
      ta.style.left = `${Math.max(4, Math.min(window.innerWidth - 8, x))}px`
      ta.style.top = `${Math.max(4, Math.min(window.innerHeight - 8, y))}px`
    }

    let raf = 0
    const reposition = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => position(false))
    }

    position(true)
    // capture=true：任何祖先容器滚动都能收到，不必知道是哪个在滚
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
    // caretOffset 放在依赖里不是给函数体用的，它是「光标动没动」的判据：
    // anchor 只是 offset 的有损投影，数字成组、标点共格时两个 offset 会投到同一格，
    // 只用 anchor 判重，那几次按键整个 effect 都不会跑，光标既不复位也不进视野。
  }, [blockId, anchor.row, anchor.column, anchor.fraction, caretOffset, layoutKey])

  // 外部改写文本（撤销 / 重置 / 切题）时同步进 textarea。
  // 组合输入期间绝不动 value，否则输入法会错乱 —— 这时 valueBlockRef 会停在旧题上，
  // 由 commitFromTextarea 的守卫负责在组合结束后丢弃那一笔并重新同步。
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    if (composingRef.current) return
    if (ta.value !== text) ta.value = text
    valueBlockRef.current = blockId
  }, [text, blockId])

  useImperativeHandle(
    ref,
    (): EditorSurfaceHandle => ({
      focusAt(offset: number, end?: number, backward?: boolean) {
        const ta = taRef.current
        if (!ta) return
        const value = ta.value
        const start = Math.max(0, Math.min(offset, value.length))
        const stop = Math.max(start, Math.min(end ?? start, value.length))
        ta.focus({ preventScroll: true })
        // 方向必须显式传：不传的话浏览器按 forward 记，之后 Shift+← 会去动错误的那一端，
        // 变成从右边把选区吃掉，而不是像原生那样往左扩。
        ta.setSelectionRange(start, stop, backward ? 'backward' : 'forward')
        onSelectionChange(start, stop)
      },
      setValue(next: string, caret: number) {
        const ta = taRef.current
        if (!ta) return
        composingRef.current = false
        ta.value = next
        const pos = Math.max(0, Math.min(caret, next.length))
        ta.focus({ preventScroll: true })
        ta.setSelectionRange(pos, pos)
        onSelectionChange(pos, pos)
      },
      getElement() {
        return taRef.current
      },
      isFocused() {
        return document.activeElement === taRef.current
      },
    }),
    [onSelectionChange],
  )

  /**
   * 移动光标。extend = 按住 Shift 时保留锚点、扩展选区
   * （原生 textarea 的 Shift+方向键不理解「按视觉行移动」，所以要自己实现）。
   */
  const applyMove = useCallback(
    (target: number, extend: boolean) => {
      const ta = taRef.current
      if (!ta) return
      const value = ta.value
      const stop = Math.max(0, Math.min(target, value.length))
      if (!extend) {
        ta.setSelectionRange(stop, stop)
        emitSelection()
        return
      }
      // 扩展选区时移动的是「焦点端」，另一端才是锚点。
      // 用错一端会导致 Shift+← 把整个选区跳过去而不是缩回一格。
      const backward = ta.selectionDirection === 'backward'
      const anchor = backward ? ta.selectionEnd : ta.selectionStart
      const start = Math.min(anchor, stop)
      const end = Math.max(anchor, stop)
      ta.setSelectionRange(start, end, stop < anchor ? 'backward' : 'forward')
      emitSelection()
    },
    [emitSelection],
  )

  /** 选区中正在移动的那一端（无选区时就是光标本身） */
  const focusOffset = useCallback((ta: HTMLTextAreaElement): number => {
    return ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd
  }, [])

  const moveVertical = useCallback(
    (direction: -1 | 1, extend: boolean, from: number) => {
      const ta = taRef.current
      if (!ta) return
      const { rows: r, tokens: t } = latest.current
      if (r.length === 0) return
      // 从「焦点端」所在的格下沉，否则带选区时会跳列
      const pos = caretPositionFor(r, from)
      const target = pos.rowIndex + direction
      if (target < 0) {
        applyMove(0, extend)
        return
      }
      if (target >= r.length) {
        applyMove(ta.value.length, extend)
        return
      }
      const cell = r[target].cells[Math.min(pos.column, r[target].cells.length - 1)]
      applyMove(snapOffset(t, offsetForCellPoint(cell, pos.fraction)), extend)
    },
    [applyMove],
  )

  const moveRowEdge = useCallback(
    (edge: 'start' | 'end', extend: boolean, from: number) => {
      const ta = taRef.current
      if (!ta) return
      const { rows: r, tokens: t } = latest.current
      if (r.length === 0) return
      const pos = caretPositionFor(r, from)
      const row = r[pos.rowIndex]
      if (!row) return
      if (edge === 'start') {
        applyMove(row.cells[0]?.sourceStart ?? 0, extend)
        return
      }
      const used = row.cells.filter((c) => !c.empty)
      const tail = used.length > 0 ? used[used.length - 1].sourceEnd : (row.cells[0]?.sourceStart ?? 0)
      applyMove(snapOffset(t, tail), extend)
    },
    [applyMove],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // 输入法组合期间一切交给 IME
      if (composingRef.current || e.nativeEvent.isComposing) return

      const ta = e.currentTarget
      const { tokens: t } = latest.current
      const hasSelection = ta.selectionStart !== ta.selectionEnd

      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase()
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault()
          onUndo()
          return
        }
        if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault()
          onRedo()
          return
        }
        // Ctrl+A / C / X / V 一律放行
        return
      }

      const extend = e.shiftKey

      switch (e.key) {
        case 'ArrowLeft': {
          e.preventDefault()
          // 扩选区时从焦点端走；不扩选区时折叠到选区左端（与原生一致）
          const from = extend ? focusOffset(ta) : ta.selectionStart
          applyMove(prevStop(t, from), extend)
          return
        }
        case 'ArrowRight': {
          e.preventDefault()
          const from = extend ? focusOffset(ta) : ta.selectionEnd
          applyMove(nextStop(t, ta.value.length, from), extend)
          return
        }
        case 'ArrowUp': {
          e.preventDefault()
          moveVertical(-1, extend, extend ? focusOffset(ta) : ta.selectionStart)
          return
        }
        case 'ArrowDown': {
          e.preventDefault()
          moveVertical(1, extend, extend ? focusOffset(ta) : ta.selectionStart)
          return
        }
        case 'Home': {
          e.preventDefault()
          moveRowEdge('start', extend, extend ? focusOffset(ta) : ta.selectionStart)
          return
        }
        case 'End': {
          e.preventDefault()
          moveRowEdge('end', extend, extend ? focusOffset(ta) : ta.selectionEnd)
          return
        }
        case 'Backspace': {
          if (hasSelection) return // 有选区时走原生删除
          const [from, to] = backspaceRange(t, ta.selectionStart)
          if (from === to) return
          e.preventDefault()
          const next = ta.value.slice(0, from) + ta.value.slice(to)
          ta.value = next
          ta.setSelectionRange(from, from)
          onCommit(normalizeText(next), from)
          return
        }
        case 'Delete': {
          if (hasSelection) return
          const [from, to] = deleteRange(t, ta.value.length, ta.selectionStart)
          if (from === to) return
          e.preventDefault()
          const next = ta.value.slice(0, from) + ta.value.slice(to)
          ta.value = next
          ta.setSelectionRange(from, from)
          onCommit(normalizeText(next), from)
          return
        }
        default:
          return
      }
    },
    [applyMove, focusOffset, moveRowEdge, moveVertical, onCommit, onRedo, onUndo],
  )

  const handleChange = useCallback(() => {
    if (composingRef.current) return
    commitFromTextarea()
  }, [commitFromTextarea])

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true
    setComposing(true)
  }, [])

  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false
    setComposing(false)
    // 组合结束才把最终文本提交给模型
    commitFromTextarea()
  }, [commitFromTextarea])

  const handleSelect = useCallback(() => {
    if (composingRef.current) return
    emitSelection()
  }, [emitSelection])

  const placeholderStyle = useMemo(() => ({ tabSize: 4 }), [])

  return (
    <textarea
      ref={taRef}
      className="editor-surface"
      defaultValue={text}
      style={placeholderStyle}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
      data-gramm="false"
      aria-label="申论作答输入区"
      tabIndex={enabled ? 0 : -1}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onKeyUp={handleSelect}
      onSelect={handleSelect}
      onClick={handleSelect}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onFocus={onFocusRequest}
      data-composing={composing ? '1' : '0'}
    />
  )
})
