/**
 * drawio-to-svg.js
 * 将 draw.io mxGraphModel XML 转换为独立 SVG
 *
 * 遵循 draw.io 的 AI 生成指南：
 * - 保持生成的图表 XML 为纯文本且未压缩
 * - 在 viewer 风格的 data-mxgraph 元数据中嵌入未压缩 XML
 * - 仅为 #create 编辑器 URL 使用原始 DEFLATE + Base64
 */

import { deflateRawSync } from 'node:zlib'

import {
  decodeEntities,
  escapeXml,
  extractCells,
  extractGraphAttrs,
  parseStyle
} from '../shared/xml-utils.js'

/**
 * 将 mxGraphModel XML 解析为结构化对象
 * @param {string} xml
 * @returns {{ graph: object, cells: object[] }}
 */
function parseDrawioXml(xml) {
  const graph = extractGraphAttrs(xml)
  const cells = extractCells(xml)
  return { graph, cells }
}

/**
 * 为 app.diagrams.net #create URL 压缩 draw.io XML。
 * @param {string} xmlString - draw.io XML 内容
 * @returns {string} raw-deflate Base64 载荷
 */
export function compressDrawioXmlForCreateUrl(xmlString) {
  if (!xmlString || typeof xmlString !== 'string' || xmlString.trim().length === 0) {
    throw new Error('输入 XML 字符串不能为空')
  }

  const encoded = encodeURIComponent(xmlString)
  return deflateRawSync(Buffer.from(encoded, 'utf8')).toString('base64')
}

/**
 * 使用官方 #create 载荷格式构建 draw.io 编辑器 URL。
 * @param {string} xmlString - draw.io XML 内容
 * @param {object} [options]
 * @param {Record<string, string|number|boolean>} [options.query] 可选 app.diagrams.net 查询参数
 * @returns {string} 编辑器 URL
 */
export function generateDrawioEditUrl(xmlString, options = {}) {
  const query = new URLSearchParams()
  const queryOptions = options.query ?? { pv: '0', grid: '0' }

  for (const [key, value] of Object.entries(queryOptions)) {
    query.set(key, String(value))
  }

  const createPayload = {
    type: 'xml',
    compressed: true,
    data: compressDrawioXmlForCreateUrl(xmlString)
  }

  return `https://app.diagrams.net/?${query.toString()}#create=${encodeURIComponent(JSON.stringify(createPayload))}`
}

function buildDataMxgraph(xmlString) {
  return escapeXml(JSON.stringify({ xml: xmlString }))
}

// ============================================================================
// 形状分类
// ============================================================================

/**
 * 从解析后的样式映射中判断形状类型
 * @param {Map<string, string>} style
 * @returns {string}
 */
function classifyShape(style) {
  if (style.get('swimlane') === '1') return 'swimlane'
  const shape = style.get('shape')
  if (shape === 'image') return 'image'
  if (shape === 'cylinder3' || shape === 'cylinder') return 'cylinder'
  if (shape === 'parallelogram') return 'parallelogram'
  if (shape === 'document') return 'document'
  if (shape === 'cloud') return 'cloud'
  if (shape === 'switch') return 'switch'
  if (shape === 'hexagon') return 'hexagon'
  if (shape === 'mxgraph.cisco.firewalls.firewall') return 'firewall'
  if (shape === 'mxgraph.cisco.wireless.access_point') return 'wirelessAp'
  if (style.has('rhombus')) return 'rhombus'
  if (style.has('ellipse')) return 'ellipse'
  const rounded = style.get('rounded')
  const arcSize = Number(style.get('arcSize')) || 0
  if (rounded === '1' && arcSize >= 50) return 'stadium'
  if (rounded === '1') return 'roundedRect'
  return 'rect'
}

// ============================================================================
// 箭头标记定义
// ============================================================================

const ARROW_TYPES = ['block', 'open', 'classic', 'diamond']

/**
 * 构建带箭头标记的 SVG <defs>
 * @returns {string}
 */
function buildMarkerDefs() {
  const markers = []

  // 块箭头（填充三角形）
  markers.push(
    '<marker id="arrow-block" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse">',
    '  <path d="M 0 0 L 10 5 L 0 10 Z" fill="currentColor"/>',
    '</marker>'
  )

  // 开口箭头（折线箭头）
  markers.push(
    '<marker id="arrow-open" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse">',
    '  <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    '</marker>'
  )

  // 经典箭头（填充箭头）
  markers.push(
    '<marker id="arrow-classic" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse">',
    '  <path d="M 0 0 L 10 5 L 0 10 L 3 5 Z" fill="currentColor"/>',
    '</marker>'
  )

  // 菱形
  markers.push(
    '<marker id="arrow-diamond" viewBox="0 0 12 12" refX="12" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse">',
    '  <path d="M 0 6 L 6 0 L 12 6 L 6 12 Z" fill="currentColor"/>',
    '</marker>'
  )

  return `<defs>\n${markers.join('\n')}\n</defs>`
}

/**
 * 将箭头类型名解析为标记 URL 引用
 * @param {string} arrowType
 * @param {'start'|'end'} position
 * @returns {string} marker-start 或 marker-end 属性，或空字符串
 */
function markerRef(arrowType, position) {
  if (!arrowType || arrowType === 'none') return ''
  const id = ARROW_TYPES.includes(arrowType) ? `arrow-${arrowType}` : 'arrow-block'
  const attrName = position === 'start' ? 'marker-start' : 'marker-end'
  return ` ${attrName}="url(#${id})"`
}

function fallbackGeometry() {
  return { x: 0, y: 0, width: 120, height: 60, relative: false }
}

function resolveAbsoluteGeometry(cell, cellMap, geometryCache) {
  if (!cell) return fallbackGeometry()
  if (geometryCache.has(cell.id)) return geometryCache.get(cell.id)

  const geometry = cell.geometry ? { ...cell.geometry } : fallbackGeometry()
  let absolute = geometry

  if (cell.parent && cell.parent !== '0' && cell.parent !== '1') {
    const parent = cellMap.get(cell.parent)
    if (parent) {
      const parentGeometry = resolveAbsoluteGeometry(parent, cellMap, geometryCache)
      absolute = {
        ...geometry,
        x: geometry.x + parentGeometry.x,
        y: geometry.y + parentGeometry.y
      }
    }
  }

  geometryCache.set(cell.id, absolute)
  return absolute
}

function normalizeLabelText(value = '') {
  return decodeEntities(String(value))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|li|h\d)>/gi, '\n')
    .replace(/<(?:div|p|li|h\d)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function estimateTextWidth(text, fontSize) {
  let width = 0
  for (const char of text) {
    if (/\s/.test(char)) {
      width += fontSize * 0.35
    } else if (/[^\u0000-\u00ff]/.test(char)) {
      width += fontSize * 0.95
    } else if (/[A-Z0-9]/.test(char)) {
      width += fontSize * 0.68
    } else {
      width += fontSize * 0.58
    }
  }
  return width
}

function tokenizeForWrap(paragraph) {
  return paragraph.match(/[\u4E00-\u9FFF]|[^\s\u4E00-\u9FFF]+|\s+/g) ?? []
}

function wrapParagraph(paragraph, maxWidth, fontSize) {
  if (!paragraph) return ['']

  const tokens = tokenizeForWrap(paragraph)
  const lines = []
  let current = ''

  const pushCurrent = () => {
    const trimmed = current.trim()
    if (trimmed) lines.push(trimmed)
    current = ''
  }

  for (const token of tokens) {
    const candidate = `${current}${token}`
    if (current && estimateTextWidth(candidate, fontSize) > maxWidth) {
      pushCurrent()
    }

    if (!current && estimateTextWidth(token.trim(), fontSize) > maxWidth) {
      let fragment = ''
      for (const char of token) {
        const nextFragment = `${fragment}${char}`
        if (fragment && estimateTextWidth(nextFragment, fontSize) > maxWidth) {
          lines.push(fragment)
          fragment = char
        } else {
          fragment = nextFragment
        }
      }
      current = fragment.trimStart()
      continue
    }

    current += token
  }

  pushCurrent()
  return lines.length > 0 ? lines : ['']
}

function wrapTextToFit(text, maxWidth, fontSize) {
  if (!text.includes('\n') && /\s\/\s/.test(text) && estimateTextWidth(text, fontSize) > maxWidth) {
    const bilingualParts = text.split(/\s\/\s/)
    if (bilingualParts.length === 2) {
      return bilingualParts.flatMap(part => wrapParagraph(part, maxWidth, fontSize))
    }
  }

  const safeWidth = Math.max(maxWidth, fontSize * 2)
  return text
    .split('\n')
    .flatMap(paragraph => wrapParagraph(paragraph, safeWidth, fontSize))
}

function buildTextElement({
  text,
  x,
  y,
  width,
  height,
  style,
  fontSize,
  fontColor,
  fontFamily,
  shapeType,
  textBounds
}) {
  const normalized = normalizeLabelText(text)
  if (!normalized) return ''

  const spacing = Number(style.get('spacing')) || 10
  const spacingTop = Number(style.get('spacingTop')) || spacing
  const spacingBottom = Number(style.get('spacingBottom')) || spacing
  const rawAlign = (style.get('align') || (shapeType === 'swimlane' ? 'left' : 'center')).toLowerCase()
  const rawVerticalAlign = (style.get('verticalAlign') || (shapeType === 'swimlane' ? 'top' : 'middle')).toLowerCase()
  const align = rawAlign === 'right' ? 'right' : rawAlign === 'left' ? 'left' : 'center'
  const verticalAlign = rawVerticalAlign === 'bottom' ? 'bottom' : rawVerticalAlign === 'top' ? 'top' : 'middle'

  let textBoxX = textBounds?.x ?? (x + spacing)
  let textBoxY = textBounds?.y ?? y
  let textBoxWidth = Math.max(textBounds?.width ?? (width - spacing * 2), fontSize * 2)
  let textBoxHeight = Math.max(textBounds?.height ?? height, fontSize + spacingTop + spacingBottom)

  if (shapeType === 'swimlane' && style.get('horizontal') === '1') {
    textBoxHeight = Math.max(Number(style.get('startSize')) || 30, fontSize + spacingTop + spacingBottom)
  }

  const lines = wrapTextToFit(normalized, textBoxWidth, fontSize)
  const lineHeight = Math.max(Math.round(fontSize * 1.25), fontSize + 2)
  const totalHeight = lines.length * lineHeight
  const textAnchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle'
  const textX = align === 'left'
    ? textBoxX
    : align === 'right'
      ? x + width - spacing
      : x + width / 2

  let startY
  if (verticalAlign === 'top') {
    startY = textBoxY + spacingTop + fontSize * 0.9
  } else if (verticalAlign === 'bottom') {
    startY = textBoxY + textBoxHeight - spacingBottom - totalHeight + fontSize * 0.9
  } else {
    startY = textBoxY + Math.max((textBoxHeight - totalHeight) / 2, 0) + fontSize * 0.9
  }

  return lines.map((line, index) => {
    const lineY = startY + index * lineHeight
    return `<text x="${textX}" y="${lineY}" text-anchor="${textAnchor}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" fill="${fontColor}">${escapeXml(line)}</text>`
  }).join('\n')
}

function pointKey(point) {
  return `${Math.round(point.x * 100) / 100},${Math.round(point.y * 100) / 100}`
}

function dedupeConsecutivePoints(points) {
  const result = []
  for (const point of points) {
    if (!result.length || pointKey(result.at(-1)) !== pointKey(point)) {
      result.push(point)
    }
  }
  return result
}

function boundaryPoint(geometry, toward) {
  const centerX = geometry.x + geometry.width / 2
  const centerY = geometry.y + geometry.height / 2
  const dx = toward.x - centerX
  const dy = toward.y - centerY

  if (dx === 0 && dy === 0) {
    return { x: centerX, y: centerY }
  }

  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : (geometry.width / 2) / Math.abs(dx)
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : (geometry.height / 2) / Math.abs(dy)
  const scale = Math.min(scaleX, scaleY)

  return {
    x: centerX + dx * scale,
    y: centerY + dy * scale
  }
}

function autoRoutePoints(sourceGeometry, targetGeometry) {
  if (!sourceGeometry || !targetGeometry) return []

  const sourceCenter = {
    x: sourceGeometry.x + sourceGeometry.width / 2,
    y: sourceGeometry.y + sourceGeometry.height / 2
  }
  const targetCenter = {
    x: targetGeometry.x + targetGeometry.width / 2,
    y: targetGeometry.y + targetGeometry.height / 2
  }

  if (Math.abs(sourceCenter.x - targetCenter.x) < 8 || Math.abs(sourceCenter.y - targetCenter.y) < 8) {
    return []
  }

  if (Math.abs(sourceCenter.x - targetCenter.x) >= Math.abs(sourceCenter.y - targetCenter.y)) {
    const midX = (sourceCenter.x + targetCenter.x) / 2
    return [
      { x: midX, y: sourceCenter.y },
      { x: midX, y: targetCenter.y }
    ]
  }

  const midY = (sourceCenter.y + targetCenter.y) / 2
  return [
    { x: sourceCenter.x, y: midY },
    { x: targetCenter.x, y: midY }
  ]
}

function rectanglesOverlap(left, right) {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
}

function horizontalSegmentHitsRect(x1, x2, y, rect, padding = 8) {
  const left = Math.min(x1, x2)
  const right = Math.max(x1, x2)
  return y >= rect.y - padding &&
    y <= rect.y + rect.height + padding &&
    right >= rect.x - padding &&
    left <= rect.x + rect.width + padding
}

function verticalSegmentHitsRect(x, y1, y2, rect, padding = 8) {
  const top = Math.min(y1, y2)
  const bottom = Math.max(y1, y2)
  return x >= rect.x - padding &&
    x <= rect.x + rect.width + padding &&
    bottom >= rect.y - padding &&
    top <= rect.y + rect.height + padding
}

function pickDetour(sourceGeometry, targetGeometry, obstacles, orientation) {
  if (obstacles.length === 0) return null

  if (orientation === 'horizontal') {
    const topCandidate = Math.max(24, Math.min(sourceGeometry.y, targetGeometry.y, ...obstacles.map(rect => rect.y)) - 24)
    const bottomCandidate = Math.max(sourceGeometry.y + sourceGeometry.height, targetGeometry.y + targetGeometry.height, ...obstacles.map(rect => rect.y + rect.height)) + 24
    return Math.abs(topCandidate - (sourceGeometry.y + sourceGeometry.height / 2)) <= Math.abs(bottomCandidate - (sourceGeometry.y + sourceGeometry.height / 2))
      ? topCandidate
      : bottomCandidate
  }

  const leftCandidate = Math.max(24, Math.min(sourceGeometry.x, targetGeometry.x, ...obstacles.map(rect => rect.x)) - 24)
  const rightCandidate = Math.max(sourceGeometry.x + sourceGeometry.width, targetGeometry.x + targetGeometry.width, ...obstacles.map(rect => rect.x + rect.width)) + 24
  return Math.abs(leftCandidate - (sourceGeometry.x + sourceGeometry.width / 2)) <= Math.abs(rightCandidate - (sourceGeometry.x + sourceGeometry.width / 2))
    ? leftCandidate
    : rightCandidate
}

function routeAroundObstacles(sourceGeometry, targetGeometry, obstacles) {
  if (!sourceGeometry || !targetGeometry) return null

  const sourceCenter = {
    x: sourceGeometry.x + sourceGeometry.width / 2,
    y: sourceGeometry.y + sourceGeometry.height / 2
  }
  const targetCenter = {
    x: targetGeometry.x + targetGeometry.width / 2,
    y: targetGeometry.y + targetGeometry.height / 2
  }

  const horizontalBias = Math.abs(sourceCenter.y - targetCenter.y) <= Math.max(sourceGeometry.height, targetGeometry.height)
  if (horizontalBias) {
    const blockers = obstacles.filter(rect => horizontalSegmentHitsRect(sourceCenter.x, targetCenter.x, sourceCenter.y, rect))
    if (blockers.length > 0) {
      const detourY = pickDetour(sourceGeometry, targetGeometry, blockers, 'horizontal')
      return [
        { x: sourceCenter.x, y: detourY },
        { x: targetCenter.x, y: detourY }
      ]
    }
  }

  const verticalBias = Math.abs(sourceCenter.x - targetCenter.x) <= Math.max(sourceGeometry.width, targetGeometry.width)
  if (verticalBias) {
    const blockers = obstacles.filter(rect => verticalSegmentHitsRect(sourceCenter.x, sourceCenter.y, targetCenter.y, rect))
    if (blockers.length > 0) {
      const detourX = pickDetour(sourceGeometry, targetGeometry, blockers, 'vertical')
      return [
        { x: detourX, y: sourceCenter.y },
        { x: detourX, y: targetCenter.y }
      ]
    }
  }

  return null
}

function pathMidpoint(points) {
  const segments = []
  let totalLength = 0

  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    if (length === 0) continue
    segments.push({ from, to, length })
    totalLength += length
  }

  if (segments.length === 0) return { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0 }

  let cursor = totalLength / 2
  for (const segment of segments) {
    if (cursor <= segment.length) {
      const ratio = cursor / segment.length
      return {
        x: segment.from.x + (segment.to.x - segment.from.x) * ratio,
        y: segment.from.y + (segment.to.y - segment.from.y) * ratio
      }
    }
    cursor -= segment.length
  }

  return segments.at(-1).to
}

function renderEdgeLabel(label, midpoint, style, fontSize, fontColor) {
  const normalized = normalizeLabelText(label)
  if (!normalized) return ''

  const lines = normalized.split('\n')
  const lineHeight = Math.max(Math.round(fontSize * 1.2), fontSize + 2)
  const textWidth = Math.max(...lines.map(line => estimateTextWidth(line, fontSize)), 0)
  const boxWidth = textWidth + 10
  const boxHeight = lines.length * lineHeight + 6
  const labelX = midpoint.x
  const labelY = midpoint.y - 6
  const backgroundColor = style.get('labelBackgroundColor')
  const parts = []

  if (backgroundColor && backgroundColor !== 'none') {
    parts.push(`<rect x="${labelX - boxWidth / 2}" y="${labelY - lineHeight + 1}" width="${boxWidth}" height="${boxHeight}" rx="4" fill="${backgroundColor}" opacity="0.92"/>`)
  }

  lines.forEach((line, index) => {
    parts.push(`<text x="${labelX}" y="${labelY + index * lineHeight}" text-anchor="middle" font-size="${fontSize}" fill="${fontColor}">${escapeXml(line)}</text>`)
  })
  return parts.join('\n')
}

// ============================================================================
// 形状 SVG 渲染器
// ============================================================================

/**
 * 将顶点单元渲染为 SVG 元素
 * @param {object} cell - 解析后的单元
 * @param {Map<string, string>} style - 解析后的样式
 * @param {{ x: number, y: number, width: number, height: number }} geometry - 绝对坐标几何
 * @returns {string} SVG 标记
 */
function renderVertex(cell, style, geometry) {
  const geo = geometry || fallbackGeometry()
  const { x, y, width, height } = geo

  const fillColor = style.get('fillColor') || '#FFFFFF'
  const strokeColor = style.get('strokeColor') || '#000000'
  const strokeWidth = Number(style.get('strokeWidth')) || 1
  const fontColor = style.get('fontColor') || '#000000'
  const fontSize = Number(style.get('fontSize')) || 12
  const fontFamily = style.get('fontFamily') || 'sans-serif'

  let dashAttr = ''
  if (style.get('dashed') === '1') {
    const pattern = style.get('dashPattern') || '3 3'
    dashAttr = ` stroke-dasharray="${pattern}"`
  }

  const shapeType = classifyShape(style)
  const parts = []
  const baseAttrs = `fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}"${dashAttr}`

  switch (shapeType) {
    case 'swimlane': {
      const startSize = Number(style.get('startSize')) || 30
      parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" ${baseAttrs}/>`)
      if (style.get('horizontal') === '1') {
        parts.push(`<line x1="${x}" y1="${y + startSize}" x2="${x + width}" y2="${y + startSize}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`)
      } else {
        parts.push(`<line x1="${x + startSize}" y1="${y}" x2="${x + startSize}" y2="${y + height}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`)
      }
      break
    }

    case 'image': {
      const imageHref = style.get('image')
      const labelAtBottom = (style.get('verticalLabelPosition') || '').toLowerCase() === 'bottom'
      const reservedLabelHeight = labelAtBottom && cell.value ? Math.max(fontSize * 2.2, 30) : 0
      const imageHeight = Math.max(height - reservedLabelHeight, height * 0.55)
      if (imageHref) {
        parts.push(`<image href="${escapeXml(imageHref)}" x="${x}" y="${y}" width="${width}" height="${imageHeight}" preserveAspectRatio="xMidYMid meet"/>`)
      } else {
        parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${imageHeight}" ${baseAttrs}/>`)
      }

      const labelSvg = buildTextElement({
        text: cell.value,
        x,
        y,
        width,
        height,
        style,
        fontSize,
        fontColor,
        fontFamily,
        shapeType,
        textBounds: labelAtBottom
          ? { x: x + 6, y: y + imageHeight, width: width - 12, height: height - imageHeight }
          : undefined
      })
      if (labelSvg) parts.push(labelSvg)
      return parts.join('\n')
    }

    case 'roundedRect': {
      const rx = Number(style.get('arcSize')) || 8
      parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" ${baseAttrs}/>`)
      break
    }

    case 'stadium': {
      const rx = height / 2
      parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" ${baseAttrs}/>`)
      break
    }

    case 'cylinder': {
      const ellipseRY = Math.min(12, height * 0.15)
      // 主体矩形
      parts.push(`<rect x="${x}" y="${y + ellipseRY}" width="${width}" height="${height - ellipseRY * 2}" ${baseAttrs}/>`)
      // 底部椭圆
      parts.push(`<ellipse cx="${x + width / 2}" cy="${y + height - ellipseRY}" rx="${width / 2}" ry="${ellipseRY}" ${baseAttrs}/>`)
      // 顶部椭圆（最后绘制，让它位于上层）
      parts.push(`<ellipse cx="${x + width / 2}" cy="${y + ellipseRY}" rx="${width / 2}" ry="${ellipseRY}" ${baseAttrs}/>`)
      // 连接顶部和底部椭圆的侧线
      parts.push(`<line x1="${x}" y1="${y + ellipseRY}" x2="${x}" y2="${y + height - ellipseRY}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`)
      parts.push(`<line x1="${x + width}" y1="${y + ellipseRY}" x2="${x + width}" y2="${y + height - ellipseRY}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`)
      break
    }

    case 'rhombus': {
      const cx = x + width / 2
      const cy = y + height / 2
      const points = `${cx},${y} ${x + width},${cy} ${cx},${y + height} ${x},${cy}`
      parts.push(`<polygon points="${points}" ${baseAttrs}/>`)
      break
    }

    case 'ellipse': {
      const cx = x + width / 2
      const cy = y + height / 2
      parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${width / 2}" ry="${height / 2}" ${baseAttrs}/>`)
      break
    }

    case 'parallelogram': {
      const skew = width * 0.2
      const points = `${x + skew},${y} ${x + width},${y} ${x + width - skew},${y + height} ${x},${y + height}`
      parts.push(`<polygon points="${points}" ${baseAttrs}/>`)
      break
    }

    case 'hexagon': {
      const inset = Math.min(width * 0.22, 24)
      const points = [
        `${x + inset},${y}`,
        `${x + width - inset},${y}`,
        `${x + width},${y + height / 2}`,
        `${x + width - inset},${y + height}`,
        `${x + inset},${y + height}`,
        `${x},${y + height / 2}`
      ].join(' ')
      parts.push(`<polygon points="${points}" ${baseAttrs}/>`)
      break
    }

    case 'switch': {
      const inset = Math.min(width * 0.18, 18)
      const d = [
        `M ${x + inset} ${y}`,
        `L ${x + width - inset} ${y}`,
        `L ${x + width} ${y + height / 2}`,
        `L ${x + width - inset} ${y + height}`,
        `L ${x + inset} ${y + height}`,
        `L ${x} ${y + height / 2}`,
        'Z'
      ].join(' ')
      const portY1 = y + height * 0.35
      const portY2 = y + height * 0.65
      parts.push(`<path d="${d}" ${baseAttrs}/>`)
      parts.push(`<line x1="${x + inset}" y1="${portY1}" x2="${x + width - inset}" y2="${portY1}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`)
      parts.push(`<line x1="${x + inset}" y1="${portY2}" x2="${x + width - inset}" y2="${portY2}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`)
      break
    }

    case 'document': {
      const waveH = height * 0.1
      const d = [
        `M ${x} ${y}`,
        `L ${x + width} ${y}`,
        `L ${x + width} ${y + height - waveH}`,
        `Q ${x + width * 0.75} ${y + height + waveH} ${x + width / 2} ${y + height - waveH}`,
        `Q ${x + width * 0.25} ${y + height - waveH * 3} ${x} ${y + height - waveH}`,
        'Z'
      ].join(' ')
      parts.push(`<path d="${d}" ${baseAttrs}/>`)
      break
    }

    case 'cloud': {
      // 简化云形：重叠圆弧
      const cx = x + width / 2
      const cy = y + height / 2
      const rx = width * 0.45
      const ry = height * 0.35
      const d = [
        `M ${x + width * 0.25} ${cy + ry * 0.5}`,
        `A ${rx * 0.5} ${ry * 0.6} 0 0 1 ${x + width * 0.15} ${cy - ry * 0.2}`,
        `A ${rx * 0.5} ${ry * 0.6} 0 0 1 ${x + width * 0.35} ${cy - ry * 0.8}`,
        `A ${rx * 0.5} ${ry * 0.5} 0 0 1 ${cx} ${y + height * 0.15}`,
        `A ${rx * 0.5} ${ry * 0.5} 0 0 1 ${x + width * 0.7} ${cy - ry * 0.7}`,
        `A ${rx * 0.6} ${ry * 0.7} 0 0 1 ${x + width * 0.85} ${cy}`,
        `A ${rx * 0.5} ${ry * 0.6} 0 0 1 ${x + width * 0.75} ${cy + ry * 0.7}`,
        `A ${rx * 0.6} ${ry * 0.4} 0 0 1 ${x + width * 0.5} ${cy + ry * 0.8}`,
        `A ${rx * 0.5} ${ry * 0.4} 0 0 1 ${x + width * 0.25} ${cy + ry * 0.5}`,
        'Z'
      ].join(' ')
      parts.push(`<path d="${d}" ${baseAttrs}/>`)
      break
    }

    case 'firewall': {
      const archHeight = height * 0.18
      const bodyTop = y + archHeight
      const brickWidth = width / 4
      const brickHeight = (height - archHeight) / 3
      const outer = [
        `M ${x} ${bodyTop}`,
        `Q ${x + width / 2} ${y - archHeight * 0.2} ${x + width} ${bodyTop}`,
        `L ${x + width} ${y + height}`,
        `L ${x} ${y + height}`,
        'Z'
      ].join(' ')
      const mortar = [
        `M ${x + brickWidth} ${bodyTop} L ${x + brickWidth} ${y + height}`,
        `M ${x + brickWidth * 2} ${bodyTop} L ${x + brickWidth * 2} ${y + height}`,
        `M ${x + brickWidth * 3} ${bodyTop} L ${x + brickWidth * 3} ${y + height}`,
        `M ${x} ${bodyTop + brickHeight} L ${x + width} ${bodyTop + brickHeight}`,
        `M ${x} ${bodyTop + brickHeight * 2} L ${x + width} ${bodyTop + brickHeight * 2}`
      ].join(' ')
      parts.push(`<path d="${outer}" ${baseAttrs}/>`)
      parts.push(`<path d="${mortar}" fill="none" stroke="${strokeColor}" stroke-width="${Math.max(strokeWidth * 0.8, 1)}"/>`)
      break
    }

    case 'wirelessAp': {
      const cx = x + width / 2
      const cy = y + height / 2
      const baseRy = height * 0.12
      const baseY = y + height * 0.78
      const arc1 = [
        `M ${cx - width * 0.16} ${cy + height * 0.02}`,
        `Q ${cx} ${cy - height * 0.18} ${cx + width * 0.16} ${cy + height * 0.02}`
      ].join(' ')
      const arc2 = [
        `M ${cx - width * 0.28} ${cy + height * 0.1}`,
        `Q ${cx} ${cy - height * 0.32} ${cx + width * 0.28} ${cy + height * 0.1}`
      ].join(' ')
      parts.push(`<ellipse cx="${cx}" cy="${baseY}" rx="${width * 0.16}" ry="${baseRy}" ${baseAttrs}/>`)
      parts.push(`<line x1="${cx}" y1="${baseY - baseRy}" x2="${cx}" y2="${cy + height * 0.12}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`)
      parts.push(`<path d="${arc1}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`)
      parts.push(`<path d="${arc2}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`)
      break
    }

    default: {
      // 普通矩形
      parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" ${baseAttrs}/>`)
      break
    }
  }

  const labelSvg = buildTextElement({
    text: cell.value,
    x,
    y,
    width,
    height,
    style,
    fontSize,
    fontColor,
    fontFamily,
    shapeType
  })
  if (labelSvg) parts.push(labelSvg)

  return parts.join('\n')
}

// ============================================================================
// 边渲染
// ============================================================================

/**
 * 计算单元几何的中心点
 * @param {object} cell
 * @param {Map<string, object>} cellMap
 * @param {Map<string, object>} geometryCache
 * @returns {{ x: number, y: number }}
 */
function cellCenter(cell, cellMap, geometryCache) {
  const geo = resolveAbsoluteGeometry(cell, cellMap, geometryCache)
  return {
    x: geo.x + geo.width / 2,
    y: geo.y + geo.height / 2
  }
}

/**
 * 将边单元渲染为 SVG 元素
 * @param {object} cell - 解析后的边单元
 * @param {Map<string, string>} style - 解析后的样式
 * @param {Map<string, object>} cellMap - id → 单元查找表
 * @param {Map<string, object>} geometryCache - 绝对几何缓存
 * @returns {string} SVG 标记
 */
function renderEdge(cell, style, cellMap, geometryCache) {
  const strokeColor = style.get('strokeColor') || '#000000'
  const strokeWidth = Number(style.get('strokeWidth')) || 1
  const fontColor = style.get('fontColor') || '#000000'
  const fontSize = Number(style.get('fontSize')) || 11

  let dashAttr = ''
  if (style.get('dashed') === '1') {
    const pattern = style.get('dashPattern') || '3 3'
    dashAttr = ` stroke-dasharray="${pattern}"`
  }

  const sourceCell = cell.source ? cellMap.get(cell.source) : null
  const targetCell = cell.target ? cellMap.get(cell.target) : null
  const sourceGeometry = sourceCell ? resolveAbsoluteGeometry(sourceCell, cellMap, geometryCache) : null
  const targetGeometry = targetCell ? resolveAbsoluteGeometry(targetCell, cellMap, geometryCache) : null

  const sourceCenter = sourceCell ? cellCenter(sourceCell, cellMap, geometryCache) : { x: 0, y: 0 }
  const targetCenter = targetCell ? cellCenter(targetCell, cellMap, geometryCache) : { x: 100, y: 100 }
  const bendPoints = (cell.geometry?.points ?? []).map(point => ({ x: point.x, y: point.y }))
  const obstacles = [...cellMap.values()]
    .filter(candidate => candidate.vertex && candidate.id !== sourceCell?.id && candidate.id !== targetCell?.id)
    .filter(candidate => parseStyle(candidate.style).get('pointerEvents') !== '0')
    .map(candidate => resolveAbsoluteGeometry(candidate, cellMap, geometryCache))
    .filter(rect => rect && !rectanglesOverlap(rect, sourceGeometry ?? fallbackGeometry()) && !rectanglesOverlap(rect, targetGeometry ?? fallbackGeometry()))
  const routePoints = bendPoints.length > 0
    ? bendPoints
    : routeAroundObstacles(sourceGeometry, targetGeometry, obstacles) ?? autoRoutePoints(sourceGeometry, targetGeometry)
  const firstToward = routePoints[0] ?? targetCenter
  const lastToward = routePoints.at(-1) ?? sourceCenter
  const startPoint = sourceGeometry ? boundaryPoint(sourceGeometry, firstToward) : sourceCenter
  const endPoint = targetGeometry ? boundaryPoint(targetGeometry, lastToward) : targetCenter
  const pathPoints = dedupeConsecutivePoints([startPoint, ...routePoints, endPoint])

  const parts = []

  // 箭头标记
  const endArrow = style.get('endArrow') || 'classic'
  const startArrow = style.get('startArrow') || ''
  const endRef = markerRef(endArrow, 'end')
  const startRef = markerRef(startArrow, 'start')
  const colorStyle = ` style="color: ${strokeColor}"`

  const pathData = pathPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
  parts.push(`<path d="${pathData}" stroke="${strokeColor}" stroke-width="${strokeWidth}"${dashAttr}${endRef}${startRef}${colorStyle} fill="none" stroke-linejoin="round" stroke-linecap="round"/>`)

  // 边标签
  const labelSvg = renderEdgeLabel(cell.value, pathMidpoint(pathPoints), style, fontSize, fontColor)
  if (labelSvg) parts.push(labelSvg)

  return parts.join('\n')
}

// ============================================================================
// 主转换器
// ============================================================================

/**
 * 将 draw.io mxGraphModel XML 转换为独立 SVG
 * @param {string} xmlString - draw.io XML 内容
 * @returns {string} SVG 标记
 * @throws {Error} 如果输入为空或不是字符串
 */
export function drawioToSvg(xmlString) {
  if (!xmlString || typeof xmlString !== 'string' || xmlString.trim().length === 0) {
    throw new Error('输入 XML 字符串不能为空')
  }

  const { graph, cells } = parseDrawioXml(xmlString)

  // 构建单元查找表
  const cellMap = new Map()
  for (const cell of cells) {
    if (cell.id) cellMap.set(cell.id, cell)
  }
  const geometryCache = new Map()

  // 分离顶点和边
  const vertices = cells.filter(c => c.vertex && c.parent !== '0')
  const edges = cells.filter(c => c.edge)

  // 默认情况下根据内容计算 viewBox 尺寸
  let svgWidth = graph.pageWidth
  let svgHeight = graph.pageHeight

  // 如果有形状超出页面边界，则扩展 viewBox
  for (const v of vertices) {
    const geometry = resolveAbsoluteGeometry(v, cellMap, geometryCache)
    if (geometry) {
      svgWidth = Math.max(svgWidth, geometry.x + geometry.width + 20)
      svgHeight = Math.max(svgHeight, geometry.y + geometry.height + 20)
    }
  }

  // 构建 SVG
  const svgParts = []
  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" ` +
    `viewBox="0 0 ${svgWidth} ${svgHeight}" data-mxgraph="${buildDataMxgraph(xmlString)}">`
  )

  // defs（箭头标记）
  svgParts.push(buildMarkerDefs())

  // 背景
  if (graph.background && graph.background !== 'none') {
    svgParts.push(`<rect x="0" y="0" width="${svgWidth}" height="${svgHeight}" fill="${graph.background}"/>`)
  }

  // 先渲染顶点，再把边渲染在上层
  for (const v of vertices) {
    const style = parseStyle(v.style)
    svgParts.push(renderVertex(v, style, resolveAbsoluteGeometry(v, cellMap, geometryCache)))
  }

  for (const e of edges) {
    const style = parseStyle(e.style)
    svgParts.push(renderEdge(e, style, cellMap, geometryCache))
  }

  svgParts.push('</svg>')
  return svgParts.join('\n')
}
