/**
 * 申论电脑模拟答题卡 —— 应用外壳
 *
 * 职责分工：
 *   逻辑文本 → layout 引擎 → 方格布局      （src/layout）
 *   文档模型 / 段落样式                     （src/document）
 *   导出                                   （src/export）
 *   本文件只做状态编排与事件转发，不含任何排版规则。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorSurface } from './components/EditorSurface'
import type { EditorSurfaceHandle } from './components/EditorSurface'
import { SheetView } from './components/SheetView'
import {
  CAPACITY_PRESETS,
  COLUMN_OPTIONS,
  appendBlock,
  blockToPlainText,
  createSheet,
  reconcileParagraphStyles,
  sheetToPlainText,
} from './document/model'
import type { AnswerBlock, AnswerSheet, ParagraphStyle } from './document/model'
import { buildPrintHtml, exportPdfViaPrint } from './export/exportPdf'
import { describeUnsupportedChars, findUnsupportedChars } from './export/pdfFontCharset'
import {
  LAYOUT_PRESETS,
  caretPositionFor,
  createDefaultProfile,
  layoutDocument,
  withProfile,
} from './layout'
import type { LayoutProfile } from './layout'
import { chooseLayout, computeGeometry, geometryToCssVars } from './sheet/geometry'
import './styles/app.css'
import './styles/sheet.css'
import './styles/print.css'

const PAGE_PX_PER_MM = 96 / 25.4

/** 示例答案：一次演示标题居中、数字两两成组、复合标点、省略号、破折号、百分号 */
const DEMO_TEXT = [
  '推动乡村振兴',
  '当前，我国经济社会发展进入新阶段，2026年农村居民人均可支配收入增长5%。',
  '他说：“我们要加快建设宜居宜业和美乡村……”',
  '——这是新时代新征程上的必答题。',
].join('\n')

interface Snapshot {
  blockId: string
  text: string
  caret: number
  styles: ParagraphStyle[]
}

function paragraphIndexAt(text: string, offset: number): number {
  let count = 0
  const limit = Math.min(offset, text.length)
  for (let i = 0; i < limit; i++) if (text[i] === '\n') count += 1
  return count
}

export default function App() {
  const [sheet, setSheet] = useState<AnswerSheet>(() => createSheet('single', 300))
  const [activeBlockId, setActiveBlockId] = useState<string>(() => sheet.blocks[0].id)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit')
  const [autoScale, setAutoScale] = useState(1)
  const [toast, setToast] = useState<string | null>(null)

  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const activeBlockIdRef = useRef(activeBlockId)
  activeBlockIdRef.current = activeBlockId

  const editorRef = useRef<EditorSurfaceHandle | null>(null)
  const printRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const undoStack = useRef<Snapshot[]>([])
  const redoStack = useRef<Snapshot[]>([])
  const lastPush = useRef({ time: 0, blockId: '' })

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 2200)
  }, [])

  // -------------------------------------------------------------------------
  // 排版配置与布局
  // -------------------------------------------------------------------------

  const profile: LayoutProfile = useMemo(() => {
    const build = LAYOUT_PRESETS[sheet.profileKey]?.build ?? createDefaultProfile
    return withProfile(build(), { columns: sheet.columns })
  }, [sheet.profileKey, sheet.columns])

  // 只依赖「容量」这个数字，不依赖整个 blocks 数组 ——
  // 否则每敲一个字都会新建 blocks 数组、连带重算几何。
  const activeCapacity = useMemo(() => {
    const active = sheet.blocks.find((b) => b.id === activeBlockId) ?? sheet.blocks[0]
    return active ? active.capacity : 0
  }, [sheet.blocks, activeBlockId])

  // 单题练习时，题目装得进一页 A4 就用 A4 纵向（纸张缩小、格子不变）；装不下才用 A3 左右两栏
  const geometry = useMemo(() => {
    const capacityRows = activeCapacity > 0 ? Math.ceil(activeCapacity / sheet.columns) : 0
    const layout = chooseLayout(sheet.columns, capacityRows, sheet.mode)
    return computeGeometry({ columns: sheet.columns, layout })
  }, [sheet.columns, sheet.mode, activeCapacity])

  const isSplit = geometry.panelsPerPage > 1
  const paperLabel = geometry.layout === 'a4-single' ? 'A4 纵向' : 'A3 横向'

  const cssVars = useMemo(() => geometryToCssVars(geometry), [geometry]) as React.CSSProperties

  const doc = useMemo(
    () =>
      layoutDocument(
        sheet.blocks.map((b) => ({
          blockId: b.id,
          blockTitle: b.title,
          text: b.text,
          capacity: b.capacity,
          paragraphs: b.paragraphStyles,
        })),
        profile,
        {
          panelsPerPage: geometry.panelsPerPage,
          rowsPerPanelForPage: geometry.rowsForPage,
        },
      ),
    [sheet.blocks, profile, geometry],
  )

  const tokensByBlockId = useMemo(
    () => new Map(doc.blocks.map((b) => [b.blockId, new Map(b.tokens.map((t) => [t.id, t]))])),
    [doc],
  )

  const activeBlock = sheet.blocks.find((b) => b.id === activeBlockId) ?? sheet.blocks[0]
  const activeLayout = doc.blocks.find((b) => b.blockId === activeBlock.id) ?? doc.blocks[0]

  const caret = useMemo(
    () => caretPositionFor(activeLayout.rows, selection.start),
    [activeLayout, selection.start],
  )

  const stats = useMemo(() => {
    const occupied = activeLayout.occupiedCellCount
    const capacity = activeLayout.capacityCells
    const logical = activeLayout.logicalCharCount
    return {
      logical,
      occupied,
      capacity,
      remaining: capacity - occupied,
      overflow: activeLayout.overflow,
      overflowCells: activeLayout.overflowCells,
      percent: capacity > 0 ? Math.min(100, (occupied / capacity) * 100) : 0,
    }
  }, [activeLayout])

  // -------------------------------------------------------------------------
  // 适应窗口缩放
  // -------------------------------------------------------------------------

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const pageWidthPx = geometry.pageWidth * PAGE_PX_PER_MM
    const measure = () => {
      const available = el.clientWidth - 44
      setAutoScale(Math.max(0.2, Math.min(1, available / pageWidthPx)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [geometry.pageWidth])

  const scale = zoomMode === 'fit' ? autoScale : zoomMode

  // 打印容器（.print-root）平时是空的，只有「导出兜底」那条路会往里写一次 ——
  // 于是用户直接按 Cmd+P 时，@media print 会把整个应用藏起来、只剩一个空容器：
  // 打出白纸；如果之前触发过兜底导出，打出的还会是那一次留下的旧答案，用户拿到作废内容。
  // 所以在系统真正开始打印之前，用当前内容刷新它。
  useEffect(() => {
    const container = printRef.current
    if (!container) return
    const refresh = () => {
      container.innerHTML = buildPrintHtml(sheetRef.current, { keepIndent: true })
    }
    window.addEventListener('beforeprint', refresh)
    return () => window.removeEventListener('beforeprint', refresh)
  }, [])

  // -------------------------------------------------------------------------
  // 编辑
  // -------------------------------------------------------------------------

  /**
   * 记一步历史。
   *
   * merge = true（默认，打字）时，600ms 内的连续输入合并成一步 —— 不然撤销一次只退一个字。
   * merge = false（工具栏动作）时**必须自己占一格**：原来不管什么动作都会刷新突发窗口，
   * 于是「打完字 600ms 内点一下工具栏」，那一格的「动作前状态」被吃掉，
   * 撤销会把打字和动作一起撤掉，而打字后的状态从没入栈，再也找不回来。
   */
  const pushHistory = useCallback((snapshot: Snapshot, merge = true) => {
    const now = Date.now()
    const bursting = merge && lastPush.current.blockId === snapshot.blockId && now - lastPush.current.time < 600
    if (!bursting) {
      undoStack.current.push(snapshot)
      if (undoStack.current.length > 300) undoStack.current.shift()
    }
    // 只有打字才续突发窗口；工具栏动作之后打字要另起一次突发
    lastPush.current = merge ? { time: now, blockId: snapshot.blockId } : { time: 0, blockId: '' }
    redoStack.current = []
  }, [])

  const handleCommit = useCallback(
    (blockId: string, nextText: string, caretOffset: number) => {
      const prev = sheetRef.current
      const block = prev.blocks.find((b) => b.id === blockId)
      if (!block || block.text === nextText) {
        setSelection({ start: caretOffset, end: caretOffset })
        return
      }
      pushHistory({
        blockId,
        text: block.text,
        caret: selectionRef.current.start,
        styles: block.paragraphStyles,
      })
      const styles = reconcileParagraphStyles(block.text, block.paragraphStyles, nextText, block.indentFirstLine)
      setSheet({
        ...prev,
        blocks: prev.blocks.map((b) => (b.id === blockId ? { ...b, text: nextText, paragraphStyles: styles } : b)),
      })
      setSelection({ start: caretOffset, end: caretOffset })
    },
    [pushHistory],
  )

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    // 兜底：题目可能已经被删掉了。这时快照既恢复不了模型，也不该写进输入层 ——
    // 写进去之后随便按一个键，那段「别人的文本」就会被提交给当前这道题。
    // 正常路径在删题时已经把这道题的历史清掉了，这里是第二道防线。
    if (!sheetRef.current.blocks.some((b) => b.id === snapshot.blockId)) return
    setActiveBlockId(snapshot.blockId)
    setSheet((prev) => ({
      ...prev,
      blocks: prev.blocks.map((b) =>
        b.id === snapshot.blockId ? { ...b, text: snapshot.text, paragraphStyles: snapshot.styles } : b,
      ),
    }))
    setSelection({ start: snapshot.caret, end: snapshot.caret })
    editorRef.current?.setValue(snapshot.text, snapshot.caret)
  }, [])

  const currentSnapshot = useCallback((): Snapshot => {
    const id = activeBlockIdRef.current
    const block = sheetRef.current.blocks.find((b) => b.id === id) ?? sheetRef.current.blocks[0]
    return {
      blockId: block.id,
      text: block.text,
      caret: selectionRef.current.start,
      styles: block.paragraphStyles,
    }
  }, [])

  /**
   * 取出一条仍然有效的快照。
   * 被删掉的题目会留下指向它的快照，那些快照既恢复不了模型，又会把已删题目的文本
   * 写进输入层，下一次按键就污染当前这道题 —— 所以直接丢弃，而不是弹出来用。
   */
  const popValidSnapshot = useCallback((stack: Snapshot[]): Snapshot | null => {
    while (stack.length > 0) {
      const entry = stack.pop() as Snapshot
      if (sheetRef.current.blocks.some((b) => b.id === entry.blockId)) return entry
    }
    return null
  }, [])

  const handleUndo = useCallback(() => {
    const entry = popValidSnapshot(undoStack.current)
    if (!entry) {
      showToast('没有可撤销的操作')
      return
    }
    redoStack.current.push(currentSnapshot())
    lastPush.current = { time: 0, blockId: '' }
    applySnapshot(entry)
  }, [applySnapshot, currentSnapshot, popValidSnapshot, showToast])

  const handleRedo = useCallback(() => {
    const entry = popValidSnapshot(redoStack.current)
    if (!entry) {
      showToast('没有可重做的操作')
      return
    }
    undoStack.current.push(currentSnapshot())
    lastPush.current = { time: 0, blockId: '' }
    applySnapshot(entry)
  }, [applySnapshot, currentSnapshot, popValidSnapshot, showToast])

  // -------------------------------------------------------------------------
  // 点击答题格定位光标
  // -------------------------------------------------------------------------

  const handlePointerDown = useCallback(
    (blockId: string, rowIndex: number, column: number, fraction: number, shift: boolean) => {
      const blockDoc = doc.blocks.find((b) => b.blockId === blockId)
      if (!blockDoc) return
      const row = blockDoc.rows[rowIndex]
      if (!row) return
      const cell = row.cells[column]
      if (!cell) return

      const tokenMap = tokensByBlockId.get(blockId)
      const rawOffset = cell.sourceStart + Math.round(fraction * (cell.sourceEnd - cell.sourceStart))
      let offset = rawOffset
      if (tokenMap) {
        const list = blockDoc.tokens
        for (const t of list) {
          if (t.caretAtomic && rawOffset > t.sourceStart && rawOffset < t.sourceEnd) {
            offset = rawOffset - t.sourceStart < t.sourceEnd - rawOffset ? t.sourceStart : t.sourceEnd
            break
          }
        }
      }

      if (blockId !== activeBlockId) {
        setActiveBlockId(blockId)
      }

      const anchor = selectionRef.current.start
      const next = shift ? { start: Math.min(anchor, offset), end: Math.max(anchor, offset) } : { start: offset, end: offset }
      setSelection(next)
      requestAnimationFrame(() => {
        // 点到锚点左边 → 锚点在右端，是反向选区；方向丢了 Shift+← 就会动错端
        editorRef.current?.focusAt(next.start, next.end, offset < anchor)
      })
    },
    [activeBlockId, doc, tokensByBlockId],
  )

  // -------------------------------------------------------------------------
  // 工具栏动作
  // -------------------------------------------------------------------------

  const updateBlock = useCallback((blockId: string, patch: Partial<AnswerBlock>) => {
    setSheet((prev) => ({
      ...prev,
      blocks: prev.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b)),
    }))
  }, [])

  const handleCapacity = useCallback(
    (capacity: number) => {
      const value = Math.max(1, Math.min(20000, Math.floor(capacity)))
      updateBlock(activeBlock.id, { capacity: value })
    },
    [activeBlock.id, updateBlock],
  )

  const handleModeChange = useCallback(
    (mode: AnswerSheet['mode']) => {
      if (mode === sheet.mode) return
      const hasContent = sheet.blocks.some((b) => b.text.trim().length > 0)
      if (hasContent && !window.confirm('切换模式会新建答题卡，当前所有作答内容将丢失。确定继续吗？')) return
      const next = createSheet(mode, activeBlock.capacity)
      undoStack.current = []
      redoStack.current = []
      setSheet(next)
      setActiveBlockId(next.blocks[0].id)
      setSelection({ start: 0, end: 0 })
      editorRef.current?.setValue('', 0)
    },
    [activeBlock.capacity, sheet.blocks, sheet.mode],
  )

  const handleReset = useCallback(() => {
    if (!window.confirm('确定要清空当前这道题的作答吗？此操作可以撤销。')) return
    const block = sheetRef.current.blocks.find((b) => b.id === activeBlock.id) ?? activeBlock
    pushHistory(
      { blockId: block.id, text: block.text, caret: selectionRef.current.start, styles: block.paragraphStyles },
      false, // 工具栏动作不并进「打字突发」，否则撤销会把动作前的打字一起撤掉，之后再也拿不回来
    )
    updateBlock(block.id, {
      text: '',
      paragraphStyles: [{ kind: 'normal', align: 'left', indentCells: block.indentFirstLine ? 2 : 0 }],
    })
    setSelection({ start: 0, end: 0 })
    editorRef.current?.setValue('', 0)
    showToast('已清空本题作答')
  }, [activeBlock, pushHistory, showToast, updateBlock])

  const handleFillDemo = useCallback(() => {
    const block = sheetRef.current.blocks.find((b) => b.id === activeBlockIdRef.current) ?? activeBlock
    pushHistory(
      { blockId: block.id, text: block.text, caret: selectionRef.current.start, styles: block.paragraphStyles },
      false, // 工具栏动作不并进「打字突发」，否则撤销会把动作前的打字一起撤掉，之后再也拿不回来
    )
    updateBlock(block.id, {
      text: DEMO_TEXT,
      paragraphStyles: [
        { kind: 'title', align: 'center', indentCells: 0 },
        { kind: 'normal', align: 'left', indentCells: block.indentFirstLine ? 2 : 0 },
        { kind: 'normal', align: 'left', indentCells: block.indentFirstLine ? 2 : 0 },
        { kind: 'normal', align: 'left', indentCells: block.indentFirstLine ? 2 : 0 },
      ],
    })
    setSelection({ start: DEMO_TEXT.length, end: DEMO_TEXT.length })
    requestAnimationFrame(() => editorRef.current?.setValue(DEMO_TEXT, DEMO_TEXT.length))
    showToast('已填入示例答案，可以看到数字、标点、引号、省略号、破折号的排布')
  }, [activeBlock, pushHistory, showToast, updateBlock])

  const handleAddBlock = useCallback(() => {
    const block = appendBlock(sheetRef.current.blocks)
    setSheet((prev) => ({ ...prev, blocks: [...prev.blocks, block] }))
    setActiveBlockId(block.id)
    setSelection({ start: 0, end: 0 })
    requestAnimationFrame(() => editorRef.current?.setValue('', 0))
    showToast(`已添加「${block.title}」`)
  }, [showToast])

  const handleRemoveBlock = useCallback(() => {
    const prev = sheetRef.current
    if (prev.blocks.length <= 1) {
      showToast('至少要保留一道题')
      return
    }
    const id = activeBlockIdRef.current
    const index = prev.blocks.findIndex((b) => b.id === id)
    if (index < 0) return
    if (prev.blocks[index].text.trim().length > 0 && !window.confirm(`「${prev.blocks[index].title}」已有作答，删除后内容会丢失。确定吗？`)) {
      return
    }
    const next = prev.blocks.filter((b) => b.id !== id)
    // 把这道题的历史一并丢掉。留着的话，撤销会弹出一道已经不存在的题目的快照，
    // 把它的文本写进输入层；之后随便按一个键，那段文本就被提交给当前这道题，
    // 覆盖掉它自己的作答。（切模式时也是这么处理整栈的。）
    undoStack.current = undoStack.current.filter((s) => s.blockId !== id)
    redoStack.current = redoStack.current.filter((s) => s.blockId !== id)
    const fallback = next[Math.max(0, index - 1)]
    setSheet({ ...prev, blocks: next })
    setActiveBlockId(fallback.id)
    setSelection({ start: 0, end: 0 })
    requestAnimationFrame(() => editorRef.current?.setValue(fallback.text, fallback.text.length))
    showToast('已删除本题')
  }, [showToast])

  const handleCopy = useCallback(async () => {
    const text = blockToPlainText(activeBlock)
    try {
      await navigator.clipboard.writeText(text)
      showToast('已复制原文（不含方格与自动换行）')
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
      showToast('已复制原文')
    }
  }, [activeBlock, showToast])

  const handleCopyAll = useCallback(async () => {
    const text = sheetToPlainText(sheet)
    try {
      await navigator.clipboard.writeText(text)
      showToast('已复制整卷原文')
    } catch {
      showToast('复制失败，请手动选择文本复制')
    }
  }, [sheet, showToast])

  const handleExportDocx = useCallback(async () => {
    try {
      // docx 库体积较大，按需加载，不拖慢首屏
      const { exportDocx } = await import('./export/exportDocx')
      await exportDocx(sheet, { keepIndent: true })
      showToast('已导出 Word（纯文字，不含方格）')
    } catch (error) {
      showToast(`导出 Word 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [sheet, showToast])

  const handleExportPdf = useCallback(async () => {
    const container = printRef.current
    const fallbackToPrint = async (reason: string) => {
      if (!container) return
      showToast(`${reason}，改用打印版导出：请在对话框中选择「另存为 PDF」`)
      await exportPdfViaPrint(container, sheet, { keepIndent: true })
    }

    // 内置字体覆盖不到的生僻字 → 直接换打印版，避免 PDF 里出现空白或豆腐块。
    // 提示里必须带上码点：这些字符常常长得跟普通空格/引号一模一样，
    // 只显示字符本身用户根本看不出要改哪儿。
    const unsupported = findUnsupportedChars(sheet.blocks.map((b) => b.text).join(''))
    if (unsupported.length > 0) {
      const more = unsupported.length > 3 ? ` 等 ${unsupported.length} 个` : ''
      await fallbackToPrint(`有 ${describeUnsupportedChars(unsupported)}${more} 内置字体没有字形`)
      return
    }

    try {
      const { exportPdfDirect } = await import('./export/exportPdfDirect')
      await exportPdfDirect(sheet, { keepIndent: true })
      showToast('已导出 PDF（纯文字，不含方格，可直接下载）')
    } catch (error) {
      await fallbackToPrint(`直接导出失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }, [sheet, showToast])

  const applyParagraphStyle = useCallback(
    (patch: Partial<ParagraphStyle>) => {
      const block = sheetRef.current.blocks.find((b) => b.id === activeBlock.id) ?? activeBlock
      pushHistory(
      { blockId: block.id, text: block.text, caret: selectionRef.current.start, styles: block.paragraphStyles },
      false, // 工具栏动作不并进「打字突发」，否则撤销会把动作前的打字一起撤掉，之后再也拿不回来
    )
      const index = paragraphIndexAt(block.text, selectionRef.current.start)
      const styles = block.paragraphStyles.map((s, i) => {
        if (i !== index) return s
        const merged = { ...s, ...patch }
        if (patch.kind === 'title' || patch.kind === 'subtitle') {
          merged.align = 'center'
          merged.indentCells = 0
        }
        if (patch.kind === 'normal' && merged.align === 'center') {
          merged.align = 'left'
          merged.indentCells = block.indentFirstLine ? 2 : 0
        }
        return merged
      })
      updateBlock(block.id, { paragraphStyles: styles })
    },
    [activeBlock, pushHistory, updateBlock],
  )

  const toggleIndent = useCallback(() => {
    const block = sheetRef.current.blocks.find((b) => b.id === activeBlock.id) ?? activeBlock
    const enabled = !block.indentFirstLine
    pushHistory(
      { blockId: block.id, text: block.text, caret: selectionRef.current.start, styles: block.paragraphStyles },
      false, // 工具栏动作不并进「打字突发」，否则撤销会把动作前的打字一起撤掉，之后再也拿不回来
    )
    updateBlock(block.id, {
      indentFirstLine: enabled,
      paragraphStyles: block.paragraphStyles.map((s) =>
        s.kind === 'normal' && s.align === 'left' ? { ...s, indentCells: enabled ? 2 : 0 } : s,
      ),
    })
  }, [activeBlock, pushHistory, updateBlock])

  const currentParagraphStyle = useMemo(() => {
    const index = paragraphIndexAt(activeBlock.text, selection.start)
    return activeBlock.paragraphStyles[index] ?? { kind: 'normal' as const, align: 'left' as const, indentCells: 0 }
  }, [activeBlock, selection.start])

  // 组件挂载后把焦点交给输入层，用户打开页面就能直接打字。
  // 但只在这 60ms 里用户没先动过手的前提下执行 ——
  // 否则「打开页面立刻点一格」会被这个定时器把光标拽回开头（实测 t+20ms 光标已在第 10 格，t+60ms 被打回 0）。
  useEffect(() => {
    let interacted = false
    const markInteracted = () => {
      interacted = true
    }
    window.addEventListener('pointerdown', markInteracted, true)
    window.addEventListener('keydown', markInteracted, true)
    const timer = window.setTimeout(() => {
      if (!interacted) editorRef.current?.focusAt(0)
    }, 60)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', markInteracted, true)
      window.removeEventListener('keydown', markInteracted, true)
    }
  }, [])

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  return (
    <>
      <div className="app" style={cssVars}>
        {/* 按钮在 mousedown 时阻止默认行为，避免抢走答题区的输入焦点
          （只拦 button，下拉框和复选框要保持可点） */}
      <div
        className="toolbar"
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) e.preventDefault()
        }}
      >
          <div className="toolbar-row">
            <span className="toolbar-label">模式</span>
            <div className="chip-group">
              <button
                type="button"
                className={`chip${sheet.mode === 'single' ? ' chip--active' : ''}`}
                onClick={() => handleModeChange('single')}
              >
                单题练习
              </button>
              <button
                type="button"
                className={`chip${sheet.mode === 'full' ? ' chip--active' : ''}`}
                onClick={() => handleModeChange('full')}
              >
                整卷模式
              </button>
            </div>

            <span className="toolbar-sep" />
            <span className="toolbar-label">本题字数</span>
            <div className="chip-group">
              {CAPACITY_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`chip${activeBlock.capacity === preset ? ' chip--active' : ''}`}
                  onClick={() => handleCapacity(preset)}
                >
                  {preset}
                </button>
              ))}
              <input
                className="input-num"
                type="number"
                min={1}
                max={20000}
                placeholder="自定义"
                value={CAPACITY_PRESETS.includes(activeBlock.capacity) ? '' : activeBlock.capacity}
                onChange={(e) => {
                  const value = Number(e.target.value)
                  if (Number.isFinite(value) && value > 0) handleCapacity(value)
                }}
              />
            </div>
          </div>

          {sheet.mode === 'full' && (
            <div className="toolbar-row">
              <span className="toolbar-label">题目</span>
              <div className="block-tabs">
                {sheet.blocks.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className={`chip${b.id === activeBlock.id ? ' chip--active' : ''}`}
                    onClick={() => {
                      setActiveBlockId(b.id)
                      requestAnimationFrame(() => editorRef.current?.focusAt(0))
                    }}
                  >
                    {b.title}
                    <span style={{ opacity: 0.65, marginLeft: 4 }}>{b.capacity}字</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="chip chip--ghost"
                  onClick={handleAddBlock}
                  title="在最后追加一道题"
                >
                  ＋ 添加题目
                </button>
                <button
                  type="button"
                  className="chip chip--ghost"
                  onClick={handleRemoveBlock}
                  title="删除当前正在作答的这一题"
                >
                  － 删除本题
                </button>
              </div>
            </div>
          )}

          <div className="toolbar-row">
            <button type="button" className="btn" onClick={handleUndo}>
              撤销
            </button>
            <button type="button" className="btn" onClick={handleRedo}>
              重做
            </button>
            <button type="button" className="btn" onClick={handleReset}>
              重置本题
            </button>
            <button type="button" className="btn" onClick={handleFillDemo} title="填入一段示例答案，用来快速查看各类排版规则">
              填入示例
            </button>

            <span className="toolbar-sep" />
            <span className="toolbar-label">段落</span>
            <div className="chip-group">
              <button
                type="button"
                className={`chip${currentParagraphStyle.kind === 'normal' ? ' chip--active' : ''}`}
                onClick={() => applyParagraphStyle({ kind: 'normal' })}
              >
                正文
              </button>
              <button
                type="button"
                className={`chip${currentParagraphStyle.kind === 'title' ? ' chip--active' : ''}`}
                onClick={() => applyParagraphStyle({ kind: 'title' })}
              >
                标题（居中）
              </button>
              <button
                type="button"
                className={`chip${currentParagraphStyle.kind === 'subtitle' ? ' chip--active' : ''}`}
                onClick={() => applyParagraphStyle({ kind: 'subtitle' })}
              >
                副标题
              </button>
              <button
                type="button"
                className={`chip${activeBlock.indentFirstLine ? ' chip--active' : ''}`}
                onClick={toggleIndent}
                title="申论大作文、应用文正文每段空两格；归纳概括等小题通常顶格"
              >
                段首缩进2格
              </button>
            </div>

            <span className="toolbar-sep" />
            <button type="button" className="btn" onClick={handleCopy}>
              复制文本
            </button>
            <span
              className="toolbar-hint"
              title="复制出来的是原始文字。段首缩进属于排版格式而不是空格字符，粘贴到 Word 等外部程序时不会带过去；需要保留首行缩进请用「导出 Word / 导出 PDF」。"
            >
              缩进不随复制带出
            </span>
            {sheet.mode === 'full' && (
              <button type="button" className="btn" onClick={handleCopyAll}>
                复制整卷
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={handleExportDocx}>
              导出 Word
            </button>
            <button type="button" className="btn btn--primary" onClick={handleExportPdf}>
              导出 PDF
            </button>

            <span className="toolbar-sep" />
            <label className="toolbar-label">
              每行格数
              <select
                className="input-num"
                style={{ width: 70, marginLeft: 6 }}
                value={sheet.columns}
                onChange={(e) => setSheet((prev) => ({ ...prev, columns: Number(e.target.value) }))}
              >
                {COLUMN_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="toolbar-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <input
                type="checkbox"
                checked={!sheet.showTemplate}
                onChange={(e) => setSheet((prev) => ({ ...prev, showTemplate: !e.target.checked }))}
              />
              隐藏模板装饰
            </label>
          </div>

          <div className="toolbar-row stats">
            <span className="stat">
              已输入 <b>{stats.logical}</b> 字
            </span>
            <span className="stat">
              已占 <b>{stats.occupied}</b> 格
            </span>
            <span className={`stat${stats.remaining < 0 ? ' stat--overflow' : ''}`}>
              剩余 <b>{stats.remaining}</b> 格
            </span>
            <span className="stat">
              目标 <b>{stats.capacity}</b> 格
            </span>
            <div className="progress">
              <div
                className={`progress-fill${stats.overflow ? ' progress-fill--over' : stats.percent > 85 ? ' progress-fill--warn' : ''}`}
                style={{ width: `${stats.percent}%` }}
              />
            </div>
            {stats.overflow && (
              <span className="banner banner--over">
                已超出设定容量 {stats.overflowCells} 格（超出部分已用红色斜纹标记，内容不会被截断）
              </span>
            )}
          </div>
        </div>

        <div className="sheet-viewport" ref={viewportRef}>
          <div className="sheet-scaler" style={{ zoom: scale } as React.CSSProperties}>
            <SheetView
              doc={doc}
              columns={geometry.columns}
              activeBlockId={activeBlock.id}
              tokensByBlockId={tokensByBlockId}
              compoundRules={profile.compoundRules}
              selStart={selection.start}
              selEnd={selection.end}
              caretRow={caret.rowIndex}
              caretColumn={caret.column}
              caretFraction={caret.fraction}
              showTemplate={sheet.showTemplate}
              split={isSplit}
              paperLabel={paperLabel}
              interactive
              onPointerDown={handlePointerDown}
            />
          </div>
        </div>

        <div className="zoom-bar">
          <button type="button" onClick={() => setZoomMode(Math.max(0.3, scale - 0.1))} title="缩小">
            −
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setZoomMode(Math.min(2, scale + 0.1))} title="放大">
            ＋
          </button>
          <button type="button" onClick={() => setZoomMode('fit')} title="适应窗口">
            ⤢
          </button>
        </div>

        <EditorSurface
          ref={editorRef}
          text={activeBlock.text}
          tokens={activeLayout.tokens}
          rows={activeLayout.rows}
          blockId={activeBlock.id}
          anchor={{ row: caret.rowIndex, column: caret.column, fraction: caret.fraction }}
          caretOffset={selection.start}
          layoutKey={`${geometry.layout}-${geometry.cell}`}
          enabled
          onCommit={(text, caretOffset) => handleCommit(activeBlock.id, text, caretOffset)}
          onSelectionChange={(start, end) => setSelection({ start, end })}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onFocusRequest={() => undefined}
        />

          {toast && <div className="toast">{toast}</div>}
      </div>

      {/*
        打印容器必须放在 .app 之外 —— 打印时整个 .app 会被 display:none 隐藏，
        放在里面会连导出内容一起被隐藏掉。
      */}
      <div className="print-root" ref={printRef} aria-hidden="true" />
    </>
  )
}
