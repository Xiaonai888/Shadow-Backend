const SHAPES = new Set(['ellipse', 'rounded', 'thought', 'shout'])
const TAILS = new Set(['none', 'bottom', 'top', 'left', 'right'])
const HEX = /^#[0-9a-fA-F]{6}$/
const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
const FONTS = {
  sans: 'Arial, "Noto Sans Khmer", sans-serif',
  serif: 'Georgia, "Noto Serif Khmer", serif',
  mono: '"Courier New", monospace',
}

export function normalizeStudioMangaBalloonOptions(options = {}) {
  const input = options && typeof options === 'object' ? options : {}
  const values = {
    shape: input.shape ?? 'ellipse',
    tail: input.tail ?? 'bottom',
    width: Number(input.width ?? 240),
    height: Number(input.height ?? 160),
    border: Number(input.border ?? 4),
    opacity: Number(input.opacity ?? 100),
    fill: input.fill ?? '#FFFFFF',
    ink: input.ink ?? '#111111',
    textColor: input.textColor ?? '#111111',
    text: String(input.text ?? ''),
    fontSize: Number(input.fontSize ?? 24),
    font: input.font ?? 'sans',
    bold: Boolean(input.bold),
    italic: Boolean(input.italic),
    align: input.align ?? 'center',
  }
  if (!SHAPES.has(values.shape) || !TAILS.has(values.tail) || !Object.hasOwn(FONTS, values.font) || !['left', 'center', 'right'].includes(values.align)) throw new Error('Unsupported Manga balloon style.')
  if (![values.fill, values.ink, values.textColor].every((value) => typeof value === 'string' && HEX.test(value))) throw new Error('Invalid Manga balloon color.')
  for (const [key, min, max] of [['width', 80, 1600], ['height', 60, 1200], ['border', 1, 30], ['opacity', 1, 100], ['fontSize', 8, 160]]) {
    if (!Number.isFinite(values[key]) || values[key] < min || values[key] > max) throw new Error(`Invalid Manga balloon ${key}.`)
  }
  if (values.text.length > 1200) throw new Error('Manga balloon text exceeds 1200 characters.')
  return values
}

function pathBody(ctx, shape, x, y, width, height) {
  ctx.beginPath()
  if (shape === 'rounded') {
    ctx.roundRect(x, y, width, height, Math.min(width, height) * 0.17)
  } else if (shape === 'shout') {
    for (let i = 0; i < 32; i += 1) {
      const angle = -Math.PI / 2 + i * Math.PI / 16
      const ratio = i % 2 ? 0.81 : 1
      const px = x + width / 2 + Math.cos(angle) * width * ratio / 2
      const py = y + height / 2 + Math.sin(angle) * height * ratio / 2
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
  } else {
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
  }
}

function drawTail(ctx, shape, direction, x, y, width, height, size) {
  if (direction === 'none' || shape === 'shout') return
  const vectors = { bottom: [0, 1], top: [0, -1], left: [-1, 0], right: [1, 0] }
  const [dx, dy] = vectors[direction]
  const midX = x + width / 2
  const midY = y + height / 2
  const halfEdge = direction === 'left' || direction === 'right' ? width / 2 : height / 2
  const baseX = midX + dx * halfEdge * 0.97
  const baseY = midY + dy * halfEdge * 0.97
  if (shape === 'thought') {
    for (let i = 1; i <= 2; i += 1) {
      ctx.beginPath()
      ctx.arc(baseX + dx * i * size * 0.43, baseY + dy * i * size * 0.43, Math.max(2, size * (0.23 - i * 0.055)), 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    return
  }
  const baseWidth = size * 0.38
  ctx.beginPath()
  ctx.moveTo(baseX - dy * baseWidth, baseY + dx * baseWidth)
  ctx.lineTo(baseX + dx * size, baseY + dy * size)
  ctx.lineTo(baseX + dy * baseWidth, baseY - dx * baseWidth)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

function splitText(ctx, text, maxWidth) {
  const rows = []
  const segments = text.replace(/\r\n?/g, '\n').split('\n')
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  for (const source of segments) {
    let line = ''
    const letters = segmenter ? Array.from(segmenter.segment(source), (piece) => piece.segment) : Array.from(source)
    for (const character of letters) {
      if (line && ctx.measureText(line + character).width > maxWidth) {
        rows.push(line)
        line = character
      } else line += character
    }
    rows.push(line)
  }
  return rows
}

export function drawStudioMangaBalloon(ctx, anchor, settings = {}) {
  if (!ctx?.canvas || typeof ctx.save !== 'function') throw new Error('A drawing canvas is required.')
  const o = normalizeStudioMangaBalloonOptions(settings)
  const cw = ctx.canvas.width
  const ch = ctx.canvas.height
  if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw < 64 || ch < 64) throw new Error('Canvas is too small for a Manga balloon.')
  const requestedX = anchor?.x ?? cw / 2
  const requestedY = anchor?.y ?? ch / 2
  if (!Number.isFinite(requestedX) || !Number.isFinite(requestedY)) throw new Error('Invalid balloon position.')
  const safe = Math.ceil(o.border / 2) + 3
  const tailSize = o.tail === 'none' || o.shape === 'shout' ? 0 : Math.min(o.width, o.height) * 0.17
  const xPad = o.tail === 'left' || o.tail === 'right' ? tailSize : 0
  const yPad = o.tail === 'top' || o.tail === 'bottom' ? tailSize : 0
  const width = Math.min(o.width, cw - safe * 2 - xPad)
  const height = Math.min(o.height, ch - safe * 2 - yPad)
  if (width < 80 || height < 60) throw new Error('Canvas is too small for the selected balloon size.')
  const leftPadding = safe + (o.tail === 'left' ? xPad : 0)
  const topPadding = safe + (o.tail === 'top' ? yPad : 0)
  const x = clamp(requestedX - width / 2, leftPadding, cw - safe - (o.tail === 'right' ? xPad : 0) - width)
  const y = clamp(requestedY - height / 2, topPadding, ch - safe - (o.tail === 'bottom' ? yPad : 0) - height)
  const middleX = x + width / 2
  const middleY = y + height / 2
  ctx.save()
  try {
    let textLayout = null
    if (o.text.trim()) {
      const textSize = Math.min(o.fontSize, Math.max(8, height * 0.24))
      const usableWidth = width * (o.shape === 'shout' ? 0.54 : o.shape === 'ellipse' ? 0.66 : 0.76)
      const usableHeight = height * (o.shape === 'shout' ? 0.48 : 0.60)
      ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${textSize}px ${FONTS[o.font]}`
      const rows = splitText(ctx, o.text.trim(), usableWidth)
      const lineHeight = textSize * 1.27
      if (rows.length * lineHeight > usableHeight) throw new Error('Text does not fit inside the balloon. Increase the balloon or reduce the font size.')
      textLayout = { usableWidth, lineHeight, rows }
    }
    ctx.globalAlpha = o.opacity / 100
    ctx.globalCompositeOperation = 'source-over'
    ctx.lineWidth = o.border
    ctx.lineJoin = 'round'
    ctx.fillStyle = o.fill
    ctx.strokeStyle = o.ink
    drawTail(ctx, o.shape, o.tail, x, y, width, height, tailSize)
    pathBody(ctx, o.shape, x, y, width, height)
    ctx.fill()
    ctx.stroke()
    if (textLayout) {
      ctx.fillStyle = o.textColor
      ctx.textAlign = o.align
      ctx.textBaseline = 'middle'
      const tx = o.align === 'left' ? middleX - textLayout.usableWidth / 2 : o.align === 'right' ? middleX + textLayout.usableWidth / 2 : middleX
      textLayout.rows.forEach((row, index) => ctx.fillText(row, tx, middleY + (index - (textLayout.rows.length - 1) / 2) * textLayout.lineHeight, textLayout.usableWidth))
    }
  } finally {
    ctx.restore()
  }
  return { x, y, width, height }
}
