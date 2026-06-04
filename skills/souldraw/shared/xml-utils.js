const XML_ENTITY_MAP = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"'
}

function parseAttrs(source = '') {
  const attrs = {}
  const attrRe = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match

  while ((match = attrRe.exec(source)) !== null) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? '')
  }

  return attrs
}

function numberAttr(attrs, name, fallback) {
  const value = Number(attrs[name])
  return Number.isFinite(value) ? value : fallback
}

function extractMxGraphModel(xml) {
  const modelMatch = xml.match(/<mxGraphModel\b[\s\S]*?<\/mxGraphModel>/)
  return modelMatch ? modelMatch[0] : xml
}

export function attr(source, name, fallback = '') {
  return parseAttrs(source)[name] ?? fallback
}

export function decodeEntities(value = '') {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (name[0] === '#') {
      const isHex = name[1]?.toLowerCase() === 'x'
      const codePoint = Number.parseInt(name.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
    }

    return XML_ENTITY_MAP[name] ?? entity
  })
}

export function escapeXml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function parseStyle(styleString = '') {
  const style = new Map()

  for (const part of styleString.split(';')) {
    if (!part) continue
    const separator = part.indexOf('=')
    if (separator === -1) {
      style.set(part, '1')
    } else {
      style.set(part.slice(0, separator), part.slice(separator + 1))
    }
  }

  return style
}

export function extractGraphAttrs(xml) {
  const model = extractMxGraphModel(xml)
  const modelTag = model.match(/<mxGraphModel\b([^>]*)>/)
  const attrs = parseAttrs(modelTag?.[1] ?? '')

  return {
    pageWidth: numberAttr(attrs, 'pageWidth', 850),
    pageHeight: numberAttr(attrs, 'pageHeight', 1100),
    background: attrs.background ?? '#FFFFFF'
  }
}

export function extractCells(xml) {
  const model = extractMxGraphModel(xml)
  const cellRe = /<mxCell\b([^>]*)\/>|<mxCell\b([^>]*)>([\s\S]*?)<\/mxCell>/g
  const cells = []
  let match

  while ((match = cellRe.exec(model)) !== null) {
    const attrs = parseAttrs(match[1] ?? match[2] ?? '')
    const body = match[3] ?? ''
    const geometryMatch = body.match(/<mxGeometry\b([^>]*)\/>|<mxGeometry\b([^>]*)>([\s\S]*?)<\/mxGeometry>/)
    const geometryAttrs = parseAttrs(geometryMatch?.[1] ?? geometryMatch?.[2] ?? '')
    const geometryBody = geometryMatch?.[3] ?? ''
    const pointsBody = geometryBody.match(/<Array\b[^>]*as\s*=\s*(?:"points"|'points')[^>]*>([\s\S]*?)<\/Array>/)?.[1] ?? ''
    const points = [...pointsBody.matchAll(/<mxPoint\b([^>]*)\/>/g)].map(pointMatch => {
      const pointAttrs = parseAttrs(pointMatch[1] ?? '')
      return {
        x: numberAttr(pointAttrs, 'x', 0),
        y: numberAttr(pointAttrs, 'y', 0)
      }
    })
    const geometry = geometryMatch
      ? {
          x: numberAttr(geometryAttrs, 'x', 0),
          y: numberAttr(geometryAttrs, 'y', 0),
          width: numberAttr(geometryAttrs, 'width', 120),
          height: numberAttr(geometryAttrs, 'height', 60),
          relative: geometryAttrs.relative === '1',
          points
        }
      : null

    cells.push({
      id: attrs.id ?? '',
      value: attrs.value ?? '',
      style: attrs.style ?? '',
      vertex: attrs.vertex === '1',
      edge: attrs.edge === '1',
      parent: attrs.parent ?? '',
      source: attrs.source ?? '',
      target: attrs.target ?? '',
      geometry
    })
  }

  return cells
}
