/**
 * PDF 导出 —— 干净的文字版，绝不含答题格。
 *
 * 选型说明（为什么用浏览器打印而不是 jsPDF）：
 *   jsPDF / pdf-lib 要输出中文必须**自带并子集化嵌入 CJK 字体**（几百 KB 到几 MB），
 *   否则就是乱码或黑方块；而浏览器的打印管线（Skia）会把系统中文矢量字体自动子集嵌入，
 *   零字体工程量、零乱码风险、文字可选中可检索。
 *   代价是必须由用户在打印对话框里选「另存为 PDF」，且要手动取消「页眉和页脚」——
 *   这一条在 UI 上给了提示。
 *
 * 实现上不用 window.open，而是在页面里常驻一个 .print-root 容器，
 * 打印时用 @media print 隐藏应用外壳、只显示它 —— 完全绕开弹窗拦截。
 */

import { splitParagraphs } from '../document/model'
import type { AnswerBlock, AnswerSheet, ParagraphStyle } from '../document/model'

export interface PdfExportOptions {
  title?: string
  keepIndent?: boolean
  blocks?: AnswerBlock[]
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 把用户真实输入的空格与制表符原样保留到 HTML。
 * HTML 默认会折叠连续空格，所以连续空格必须换成 &nbsp;。
 */
function escapePreservingWhitespace(text: string): string {
  return escapeHtml(text)
    .replace(/\t/g, '<span class="pdf-tab"></span>')
    .replace(/ {2,}/g, (m) => '&nbsp;'.repeat(m.length))
}

function paragraphHtml(text: string, style: ParagraphStyle, keepIndent: boolean): string {
  const classes = ['pdf-para']
  if (style.align === 'center') classes.push('center')
  if (style.align === 'right') classes.push('right')
  const indent = keepIndent && style.indentCells > 0 ? ` style="text-indent:${style.indentCells}em"` : ''
  if (text.length === 0) return `<p class="${classes.join(' ')} pdf-empty"${indent}>&#8203;</p>`
  return `<p class="${classes.join(' ')}"${indent}>${escapePreservingWhitespace(text)}</p>`
}

/**
 * 生成打印用的干净 HTML 片段（A4 纵向、标题居中、段首缩进）。
 *
 * 只返回 body 片段，样式由 styles/print.css 提供并对 .print-root 作用域生效，
 * 这样打印内容与应用界面的样式彻底隔离，也不会污染屏幕上的页面。
 * 纯函数，方便单测断言「产物里没有方格、没有答题卡模板」。
 */
export function buildPrintHtml(sheet: AnswerSheet, options: PdfExportOptions = {}): string {
  const keepIndent = options.keepIndent ?? true
  const blocks = options.blocks ?? sheet.blocks
  const parts: string[] = []

  if (options.title && options.title.trim().length > 0) {
    parts.push(`<h1 class="pdf-title">${escapeHtml(options.title.trim())}</h1>`)
  }

  blocks.forEach((block, blockIndex) => {
    if (blocks.length > 1) {
      if (blockIndex > 0) parts.push('<div class="pdf-gap"></div>')
      parts.push(`<h2 class="pdf-block-title">【${escapeHtml(block.title)}】</h2>`)
    }
    const paragraphs = splitParagraphs(block.text)
    const styles = block.paragraphStyles
    paragraphs.forEach((text, i) => {
      const style: ParagraphStyle = styles[i] ?? { kind: 'normal', align: 'left', indentCells: 0 }
      if (style.kind === 'title' || style.kind === 'subtitle') {
        const cls = style.kind === 'title' ? 'pdf-title' : 'pdf-subtitle'
        // 与正文段一致：标题里的连续空格与制表符同样不能被浏览器折叠
        parts.push(`<p class="${cls}">${escapePreservingWhitespace(text)}</p>`)
        return
      }
      parts.push(paragraphHtml(text, style, keepIndent))
    })
  })

  return parts.join('\n')
}

/**
 * 调起打印 → 用户在对话框里选「另存为 PDF」。
 *
 * @param container 页面里常驻的 .print-root 容器
 */
export async function exportPdfViaPrint(
  container: HTMLElement,
  sheet: AnswerSheet,
  options: PdfExportOptions = {},
): Promise<void> {
  container.innerHTML = buildPrintHtml(sheet, options)

  // 字体没加载完就打印会掉字
  if (document.fonts) {
    try {
      await document.fonts.ready
    } catch {
      /* 忽略：字体 API 不可用时直接打印 */
    }
  }
  await new Promise((resolve) => window.setTimeout(resolve, 60))

  window.print()
}
