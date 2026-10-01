/**
 * 字形墨迹实测
 *
 * 要把一个标点的**墨迹**摆到格子的指定位置，必须知道两件事：墨迹在字身框里的位置、
 * 以及字身框相对「居中摆放时的元素中心」偏了多少。这两件事都随字体和字号变化 ——
 * 楷体、宋体、思源宋体的句号墨迹位置都不一样，Windows 的 KaiTi 和 macOS 的 Kaiti SC 也不一样。
 *
 * 之前代码里写的是一张**手估**的锚点表，结果就是：两个标点被算到几乎同一个位置、
 * 引号被格子边框裁掉。猜字体度量这件事本身就不可靠。
 *
 * 现在改成运行时用 canvas 实测：`measureText` 返回的 `actualBoundingBox*` 系列字段
 * 就是墨迹的真实外框，浏览器已经替我们量好了。测出来的量按字号归一化成 em 比例后缓存，
 * 之后不管什么字号都能用同一个值换算。
 */

export interface GlyphInkMetrics {
  /** 墨迹中心相对「文字居中时的元素中心」的横向偏移（em，向右为正） */
  offsetXEm: number
  /** 墨迹中心相对「文字居中时的元素中心」的纵向偏移（em，向下为正） */
  offsetYEm: number
  /** 墨迹宽 / 高（em），用于判断会不会被格子裁到 */
  inkWidthEm: number
  inkHeightEm: number
  /**
   * 这一串字符**自然排下来**占多宽（em，含字间距）。
   *
   * 墨迹宽只说明「黑的部分有多宽」，两个字形之间该留多大空要看字体的 advance。
   * 序号（1、 一、 （1））要像小数那样连着写，靠的就是这个值 ——
   * 按它算总宽，放不下时整体等比缩小，字间距始终由字体决定。
   * 旧数据可能没有这个字段，取值处一律用 widthEmOf() 兜底。
   */
  advanceEm?: number
}

/**
 * 量不到时的兜底值（node 测试环境、极老浏览器）。
 * 取一个偏保守的中文标点墨迹尺寸，宁可让排布松一点，也不要因为「默认墨迹 1em 宽」
 * 把位置夹得离奇。
 */
const FALLBACK_METRICS: GlyphInkMetrics = {
  offsetXEm: 0,
  offsetYEm: 0,
  inkWidthEm: 0.4,
  inkHeightEm: 0.4,
  // 故意不填 advanceEm：量不到时交给 widthEmOf 按字符估
  // （写死 1em 会让「一、」这种多字串被当成一个字宽）
}

/**
 * 一串字符自然排下来的宽度（em）。
 * 优先用实测的 advance；旧数据没这个字段时按字符估：
 * 中日韩全角 1em、其余（数字、半角字母标点）0.5em。
 */
export function widthEmOf(text: string, metrics: GlyphInkMetrics): number {
  if (metrics.advanceEm !== undefined) return metrics.advanceEm
  let w = 0
  for (const ch of text) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.5
  return w
}

const cache = new Map<string, GlyphInkMetrics>()

let cachedFontFamily: string | null = null

/**
 * 取答题格里实际生效的字体族。
 * 直接读 CSS 变量算出来的最终 font-family，保证 canvas 量的是同一个字体。
 */
export function getCellFontFamily(): string {
  if (cachedFontFamily) return cachedFontFamily
  if (typeof document === 'undefined') return 'serif'
  try {
    const probe = document.createElement('span')
    probe.className = 'glyph'
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.pointerEvents = 'none'
    document.body.appendChild(probe)
    const family = getComputedStyle(probe).fontFamily
    probe.remove()
    // jsdom 没有真实样式系统，会返回 "depends on user agent" 这类占位串，不能拿来当字体名
    const usable = family && family.length > 0 && !/depends on|^initial$|^inherit$/i.test(family)
    cachedFontFamily = usable ? family : 'serif'
  } catch {
    cachedFontFamily = 'serif'
  }
  return cachedFontFamily
}

const REFERENCE_SIZE = 200

function measure(text: string, fontFamily: string): GlyphInkMetrics {
  if (typeof document === 'undefined') return FALLBACK_METRICS
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return FALLBACK_METRICS

    ctx.font = `${REFERENCE_SIZE}px ${fontFamily}`
    const m = ctx.measureText(text)
    const advance = m.width
    if (!Number.isFinite(advance) || advance <= 0) return FALLBACK_METRICS

    const left = m.actualBoundingBoxLeft ?? 0
    const right = m.actualBoundingBoxRight ?? 0
    const inkAscent = m.actualBoundingBoxAscent ?? 0
    const inkDescent = m.actualBoundingBoxDescent ?? 0
    // 字体自身的行高度量；取不到时按常见中文字体比例兜底
    const fontAscent = m.fontBoundingBoxAscent ?? REFERENCE_SIZE * 0.88
    const fontDescent = m.fontBoundingBoxDescent ?? REFERENCE_SIZE * 0.12

    // 文字在元素里是水平居中（按 advance 宽度）、垂直居中（按字体行高）摆放的
    const inkCenterFromOrigin = (right - left) / 2
    const baselineFromCenter = (fontAscent - fontDescent) / 2
    const inkCenterFromBaseline = -(inkAscent - inkDescent) / 2

    return {
      offsetXEm: (inkCenterFromOrigin - advance / 2) / REFERENCE_SIZE,
      offsetYEm: (baselineFromCenter + inkCenterFromBaseline) / REFERENCE_SIZE,
      inkWidthEm: (left + right) / REFERENCE_SIZE,
      inkHeightEm: (inkAscent + inkDescent) / REFERENCE_SIZE,
      advanceEm: advance / REFERENCE_SIZE,
    }
  } catch {
    return FALLBACK_METRICS
  }
}

/** 取某个字形的墨迹度量（按字体族 + 文字缓存） */
export function glyphInkMetrics(text: string, fontFamily = getCellFontFamily()): GlyphInkMetrics {
  const key = `${fontFamily}|${text}`
  const hit = cache.get(key)
  if (hit) return hit
  const value = measure(text, fontFamily)
  cache.set(key, value)
  return value
}

/** 供测试使用：注入一套确定的度量，绕开 canvas */
export function __setMetricsForTest(fontFamily: string, text: string, metrics: GlyphInkMetrics): void {
  cache.set(`${fontFamily}|${text}`, metrics)
}

export function __clearMetricsCacheForTest(): void {
  cache.clear()
}
