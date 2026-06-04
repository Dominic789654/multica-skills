"""
mxGraph / draw.io XML 校验工具。

复制自 drawio-agent/src/drawio_agent/utils/mxgraph.py。
保留为独立脚本，方便技能包使用者在不依赖完整 drawio-agent
包的情况下使用。

CLI 用法：
    python mxgraph_validation.py diagram.drawio
"""
from __future__ import annotations

import base64
import binascii
import json
import re
import sys
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from html import unescape as html_unescape
from urllib.parse import unquote


# ---------------------------------------------------------------------------
# 数据类
# ---------------------------------------------------------------------------

@dataclass
class MxGraphValidationError(ValueError):
    error_type: str
    message: str
    cell_id: str | None = None

    def __str__(self) -> str:
        return f"{self.error_type}: {self.message}"


@dataclass(frozen=True)
class MxGraphValidationIssue:
    error_type: str
    message: str
    cell_id: str | None = None


# ---------------------------------------------------------------------------
# 内部辅助函数
# ---------------------------------------------------------------------------

def _tag_name(tag: str) -> str:
    if tag.startswith("{") and "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def _iter_cells(root_element: ET.Element):
    for element in root_element.iter():
        if _tag_name(element.tag) == "mxCell":
            yield element


def _iter_descendant_cells(element: ET.Element):
    for child in element.iter():
        if child is element:
            continue
        if _tag_name(child.tag) == "mxCell":
            yield child


def _has_geometry(cell: ET.Element) -> bool:
    return any(_tag_name(child.tag) == "mxGeometry" for child in cell)


_GEOMETRY_POINT_ROLES = {"sourcePoint", "targetPoint", "offset"}
_POINT_COORD_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _starts_with_xml_declaration(xml: str) -> bool:
    normalized = xml.lstrip("\ufeff").lstrip()
    return normalized.startswith("<?xml")


def _serialize_mxgraph_model(model: ET.Element, *, include_xml_declaration: bool) -> str:
    serialized = ET.tostring(model, encoding="unicode")
    if include_xml_declaration:
        return f'<?xml version="1.0" encoding="UTF-8"?>\n{serialized}'
    return serialized


def _decode_base64_text(value: str) -> str | None:
    normalized = value.strip()
    if not normalized:
        return None
    try:
        padded = normalized + ("=" * (-len(normalized) % 4))
        return base64.b64decode(padded).decode("utf-8")
    except (ValueError, UnicodeDecodeError, binascii.Error):
        return None


def _decode_deflated_base64_text(value: str) -> str | None:
    normalized = value.strip()
    if not normalized:
        return None
    try:
        padded = normalized + ("=" * (-len(normalized) % 4))
        compressed = base64.b64decode(padded)
        inflated = zlib.decompress(compressed, -15).decode("utf-8")
        return unquote(inflated)
    except (ValueError, UnicodeDecodeError, zlib.error, binascii.Error):
        return None


def _extract_from_embedded_text(value: str) -> str | None:
    normalized = html_unescape(value).lstrip("\ufeff").strip()
    if not normalized:
        return None

    text_candidates = [normalized]
    unquoted = unquote(normalized)
    if unquoted != normalized:
        text_candidates.append(unquoted)

    for text_candidate in text_candidates:
        if "<mxGraphModel" not in text_candidate and "<mxfile" not in text_candidate:
            continue
        extracted = extract_mxgraph_xml(text_candidate)
        if "<mxGraphModel" in extracted:
            return extracted

    for text_candidate in text_candidates:
        for decoded in (
            _decode_base64_text(text_candidate),
            _decode_deflated_base64_text(text_candidate),
        ):
            if decoded:
                decoded_extracted = _extract_from_embedded_text(decoded)
                if decoded_extracted:
                    return decoded_extracted

    return None


def _extract_from_data_mxgraph(value: str) -> str | None:
    candidates = [value, unquote(value), html_unescape(value)]
    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        for key in ("xml", "xmlData", "diagram"):
            embedded = payload.get(key)
            if not isinstance(embedded, str):
                continue
            extracted = _extract_from_embedded_text(embedded)
            if extracted:
                return extracted
    return None


def _extract_from_svg_document(svg: ET.Element) -> str | None:
    for element in svg.iter():
        data_drawio = element.get("data-drawio")
        if data_drawio:
            extracted = _extract_from_embedded_text(data_drawio)
            if extracted:
                return extracted

        content = element.get("content")
        if content:
            extracted = _extract_from_embedded_text(content)
            if extracted:
                return extracted

        data_mxgraph = element.get("data-mxgraph")
        if data_mxgraph:
            extracted = _extract_from_data_mxgraph(data_mxgraph)
            if extracted:
                return extracted

    return None


def _parse_points_attribute(value: str) -> list[tuple[str, str]] | None:
    coords = _POINT_COORD_RE.findall(value)
    if len(coords) < 2 or len(coords) % 2 != 0:
        return None
    return list(zip(coords[::2], coords[1::2]))


# ---------------------------------------------------------------------------
# 公开 API
# ---------------------------------------------------------------------------

def extract_mxgraph_xml(xml: str) -> str:
    """拆开 <mxfile> 外壳并返回内部 mxGraphModel XML。"""
    without_bom = xml.lstrip("\ufeff")
    normalized = without_bom.strip()
    if not normalized:
        return xml

    try:
        document = ET.fromstring(normalized)
    except ET.ParseError:
        return xml

    document_tag = _tag_name(document.tag)
    if document_tag == "mxGraphModel":
        return without_bom
    if document_tag == "svg":
        embedded = _extract_from_svg_document(document)
        if embedded:
            return embedded
        return xml
    if document_tag != "mxfile":
        return xml

    for diagram in document.iter():
        if _tag_name(diagram.tag) != "diagram":
            continue

        for child in diagram:
            if _tag_name(child.tag) == "mxGraphModel":
                return ET.tostring(child, encoding="unicode")

        embedded = (diagram.text or "").lstrip("\ufeff").strip()
        if not embedded:
            continue
        if "<mxGraphModel" in embedded:
            return embedded

        try:
            padded = embedded + ("=" * (-len(embedded) % 4))
            compressed = base64.b64decode(padded)
            inflated = zlib.decompress(compressed, -15).decode("utf-8")
            decoded = unquote(inflated).strip()
        except (ValueError, UnicodeDecodeError, zlib.error, binascii.Error):
            continue

        if "<mxGraphModel" in decoded:
            return decoded

    return xml


def normalize_mxgraph_xml(xml: str) -> str:
    """将 <Array points="..."> 简写修复为正确的 <Array as="points"><mxPoint .../></Array>。"""
    try:
        model = ET.fromstring(xml)
    except ET.ParseError:
        return xml

    changed = False
    for geometry in model.iter():
        if _tag_name(geometry.tag) != "mxGeometry":
            continue
        for child in list(geometry):
            if _tag_name(child.tag) != "Array":
                continue
            points_attr = (child.get("points") or "").strip()
            if not points_attr:
                continue
            pairs = _parse_points_attribute(points_attr)
            if pairs is None:
                continue

            child.attrib.clear()
            child.set("as", "points")
            for grandchild in list(child):
                child.remove(grandchild)
            for x, y in pairs:
                point = ET.SubElement(child, "mxPoint")
                point.set("x", x)
                point.set("y", y)
            changed = True

    if not changed:
        return xml

    return _serialize_mxgraph_model(
        model,
        include_xml_declaration=_starts_with_xml_declaration(xml),
    )


def _parse_style_map(style: str | None) -> dict[str, str]:
    style_map: dict[str, str] = {}
    for segment in (style or "").split(";"):
        part = segment.strip()
        if not part:
            continue
        if "=" in part:
            key, value = part.split("=", 1)
            style_map[key.strip()] = value.strip()
        else:
            style_map[part] = "1"
    return style_map


def _parse_dimension(value: str | None) -> float | None:
    normalized = (value or "").strip()
    if not normalized:
        return None
    try:
        return float(normalized)
    except ValueError:
        return None


def _geometry_rect(cell: ET.Element) -> tuple[float, float, float, float] | None:
    geometry = next((child for child in cell if _tag_name(child.tag) == "mxGeometry"), None)
    if geometry is None:
        return None
    try:
        return (
            float((geometry.get("x") or "0").strip() or "0"),
            float((geometry.get("y") or "0").strip() or "0"),
            float((geometry.get("width") or "0").strip() or "0"),
            float((geometry.get("height") or "0").strip() or "0"),
        )
    except ValueError:
        return None


def _is_visible_vertex(cell: ET.Element) -> bool:
    return cell.get("vertex") == "1" and _geometry_rect(cell) is not None


def _participates_in_overlap_check(cell: ET.Element) -> bool:
    style_map = _parse_style_map(cell.get("style"))
    return (
        _is_visible_vertex(cell)
        and style_map.get("text") != "1"
        and style_map.get("pointerEvents") != "0"
    )


def _rectangles_overlap(
    left: tuple[float, float, float, float],
    right: tuple[float, float, float, float],
) -> bool:
    left_x, left_y, left_width, left_height = left
    right_x, right_y, right_width, right_height = right
    return (
        left_x < right_x + right_width
        and left_x + left_width > right_x
        and left_y < right_y + right_height
        and left_y + left_height > right_y
    )


def _validate_root_vertex_page_bounds(
    model: ET.Element,
    cell_by_id: dict[str, ET.Element],
) -> None:
    page_width = _parse_dimension(model.get("pageWidth"))
    page_height = _parse_dimension(model.get("pageHeight"))
    if page_width is None or page_height is None:
        return

    root_rects = [
        rect
        for cell_id, cell in cell_by_id.items()
        if cell_id not in {"0", "1"}
        and (cell.get("parent") or "").strip() == "1"
        and _is_visible_vertex(cell)
        for rect in [_geometry_rect(cell)]
        if rect is not None
    ]
    if not root_rects:
        return

    max_right = max(x + width for x, _y, width, _height in root_rects)
    max_bottom = max(y + height for _x, y, _width, height in root_rects)
    min_left = min(x for x, _y, _width, _height in root_rects)
    min_top = min(y for _x, y, _width, _height in root_rects)

    if min_left < 0 or min_top < 0 or max_right > page_width or max_bottom > page_height:
        raise MxGraphValidationError(
            "RootVertexOutOfBounds",
            "根层可见节点超出页面边界："
            f"内容边界 {max_right:g}x{max_bottom:g} 超出 "
            f"pageWidth/pageHeight {page_width:g}x{page_height:g}",
        )


def _validate_same_parent_vertex_overlaps(cell_by_id: dict[str, ET.Element]) -> None:
    by_parent: dict[str, list[tuple[str, tuple[float, float, float, float]]]] = {}
    for cell_id, cell in cell_by_id.items():
        if cell_id in {"0", "1"} or not _participates_in_overlap_check(cell):
            continue
        rect = _geometry_rect(cell)
        if rect is None:
            continue
        parent = (cell.get("parent") or "").strip()
        by_parent.setdefault(parent, []).append((cell_id, rect))

    for parent, siblings in by_parent.items():
        for left_index in range(len(siblings)):
            left_id, left_rect = siblings[left_index]
            for right_index in range(left_index + 1, len(siblings)):
                right_id, right_rect = siblings[right_index]
                if _rectangles_overlap(left_rect, right_rect):
                    raise MxGraphValidationError(
                        "VisibleVertexOverlap",
                        f"同一 parent '{parent}' 下的可见顶点 '{left_id}' 与 '{right_id}' 发生重叠",
                        cell_id=left_id,
                    )


def _validate_mxgeometry_children(geometry: ET.Element, *, cell_id: str) -> None:
    for child in geometry:
        child_tag = _tag_name(child.tag)
        if child_tag == "Array":
            if (child.get("as") or "").strip() != "points":
                raise MxGraphValidationError(
                    "InvalidGeometryArray",
                    f"mxCell '{cell_id}' 有一个 <Array> 子节点，必须声明 as=\"points\"",
                    cell_id=cell_id,
                )
            if child.get("points") is not None:
                raise MxGraphValidationError(
                    "InvalidGeometryArray",
                    f"mxCell '{cell_id}' 使用了不支持的 <Array points=\"...\"> 简写；"
                    f"请使用 <Array as=\"points\"><mxPoint .../></Array>",
                    cell_id=cell_id,
                )
            for point in child:
                if _tag_name(point.tag) != "mxPoint":
                    raise MxGraphValidationError(
                        "InvalidGeometryArray",
                        f"mxCell '{cell_id}' 有一个 <Array as=\"points\"> 子节点，其中包含"
                        f"不支持的 <{_tag_name(point.tag)}>",
                        cell_id=cell_id,
                    )
                if list(point):
                    raise MxGraphValidationError(
                        "InvalidGeometryArray",
                        f"mxCell '{cell_id}' 在 <Array as=\"points\"> 内有一个包含嵌套元素的 "
                        f"<mxPoint>",
                        cell_id=cell_id,
                    )
                if point.get("x") is None and point.get("y") is None:
                    raise MxGraphValidationError(
                        "InvalidGeometryArray",
                        f"mxCell '{cell_id}' 在 <Array as=\"points\"> 内有一个缺少 x/y 坐标的 "
                        f"<mxPoint>",
                        cell_id=cell_id,
                    )
                if point.get("as") is not None:
                    raise MxGraphValidationError(
                        "InvalidGeometryArray",
                        f"mxCell '{cell_id}' 在 <Array as=\"points\"> 内有一个不应声明 as 属性的 "
                        f"<mxPoint>",
                        cell_id=cell_id,
                    )
            continue

        if child_tag == "mxPoint":
            point_role = (child.get("as") or "").strip()
            if point_role not in _GEOMETRY_POINT_ROLES:
                raise MxGraphValidationError(
                    "InvalidGeometryPoint",
                    f"mxCell '{cell_id}' 有一个 <mxPoint> 子节点，其 as=\"{point_role or '(missing)'}\" "
                    f"不受支持",
                    cell_id=cell_id,
                )
            if list(child):
                raise MxGraphValidationError(
                    "InvalidGeometryPoint",
                    f"mxCell '{cell_id}' 有一个包含嵌套元素的 <mxPoint> 子节点",
                    cell_id=cell_id,
                )
            if point_role == "offset" and child.get("x") is None and child.get("y") is None:
                continue
            if child.get("x") is None and child.get("y") is None:
                raise MxGraphValidationError(
                    "InvalidGeometryPoint",
                    f"mxCell '{cell_id}' 有一个缺少 x/y 坐标的 <mxPoint as=\"{point_role}\">",
                    cell_id=cell_id,
                )
            continue

        if child_tag == "mxRectangle":
            if (child.get("as") or "").strip() != "alternateBounds":
                raise MxGraphValidationError(
                    "InvalidGeometryRectangle",
                    f"mxCell '{cell_id}' 有一个 <mxRectangle> 子节点，必须声明 as=\"alternateBounds\"",
                    cell_id=cell_id,
                )
            if list(child):
                raise MxGraphValidationError(
                    "InvalidGeometryRectangle",
                    f"mxCell '{cell_id}' 有一个包含嵌套元素的 <mxRectangle as=\"alternateBounds\">",
                    cell_id=cell_id,
                )
            continue

        raise MxGraphValidationError(
            "UnsupportedGeometryChild",
            f"mxCell '{cell_id}' 在 <mxGeometry> 内有不支持的 <{child_tag}>",
            cell_id=cell_id,
        )


def validate_mxgraph_xml(xml: str) -> None:
    """完整结构校验器。发现第一个问题时抛出 MxGraphValidationError。"""
    try:
        model = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise MxGraphValidationError(
            "XmlParseError",
            f"XML 解析错误：{exc}",
        ) from exc

    if _tag_name(model.tag) != "mxGraphModel":
        raise MxGraphValidationError(
            "RootTagError",
            f"预期根标签为 'mxGraphModel'，实际为 '{_tag_name(model.tag)}'",
        )

    root_elements = [child for child in model if _tag_name(child.tag) == "root"]
    if not root_elements:
        raise MxGraphValidationError("MissingRoot", "mxGraphModel 必须包含一个 <root> 元素")
    if len(root_elements) > 1:
        raise MxGraphValidationError("MultipleRootElements", "mxGraphModel 只能包含一个 <root> 元素")
    root = root_elements[0]

    for child in root:
        child_tag = _tag_name(child.tag)
        if child_tag == "mxCell":
            continue

        wrapped_cells = list(_iter_descendant_cells(child))
        if not wrapped_cells:
            raise MxGraphValidationError(
                "InvalidRootChild",
                f"<root> 下直接出现了不支持的 <{child_tag}>；根子节点必须是 "
                f"mxCell 节点或包含一个 mxCell 的对象包装",
            )
        if len(wrapped_cells) > 1:
            raise MxGraphValidationError(
                "MultipleWrappedCells",
                f"被包装的根子节点 <{child_tag}> 只能包含一个 mxCell",
            )

    cell_by_id: dict[str, ET.Element] = {}
    for cell in _iter_cells(root):
        cell_id = (cell.get("id") or "").strip()
        if not cell_id:
            raise MxGraphValidationError("MissingCellId", "发现缺少 id 属性的 <mxCell>")
        if cell_id in cell_by_id:
            raise MxGraphValidationError(
                "DuplicateCellId",
                f"重复的 mxCell id '{cell_id}'",
                cell_id=cell_id,
            )
        cell_by_id[cell_id] = cell

    if "0" not in cell_by_id:
        raise MxGraphValidationError("MissingCell0", '缺少必需的 <mxCell id="0"/>')
    if "1" not in cell_by_id:
        raise MxGraphValidationError("MissingCell1", '缺少必需的 <mxCell id="1" parent="0"/>')
    if (cell_by_id["1"].get("parent") or "").strip() != "0":
        raise MxGraphValidationError(
            "InvalidCell1Parent",
            'mxCell id="1" 必须声明 parent="0"',
            cell_id="1",
        )

    for cell_id, cell in cell_by_id.items():
        nested_cells = list(_iter_descendant_cells(cell))
        if nested_cells:
            raise MxGraphValidationError(
                "NestedCell",
                f"mxCell '{cell_id}' 包含嵌套的 mxCell 后代；"
                f"请改为在单元外包装元数据",
                cell_id=cell_id,
            )

        if cell_id != "0":
            parent = (cell.get("parent") or "").strip()
            if not parent:
                raise MxGraphValidationError(
                    "MissingParent",
                    f"mxCell '{cell_id}' 必须声明 parent",
                    cell_id=cell_id,
                )
            if parent not in cell_by_id:
                raise MxGraphValidationError(
                    "DanglingParent",
                    f"mxCell '{cell_id}' 引用了缺失的 parent '{parent}'",
                    cell_id=cell_id,
                )

        if cell.get("vertex") == "1" or cell.get("edge") == "1":
            if not _has_geometry(cell):
                raise MxGraphValidationError(
                    "MissingGeometry",
                    f"mxCell '{cell_id}' 缺少 <mxGeometry ... as=\"geometry\"/> 子节点",
                    cell_id=cell_id,
                )
            for child in cell:
                if _tag_name(child.tag) == "mxGeometry":
                    _validate_mxgeometry_children(child, cell_id=cell_id)

        source = (cell.get("source") or "").strip()
        if source and source not in cell_by_id:
            raise MxGraphValidationError(
                "DanglingSource",
                f"mxCell '{cell_id}' 引用了缺失的 source '{source}'",
                cell_id=cell_id,
            )

        target = (cell.get("target") or "").strip()
        if target and target not in cell_by_id:
            raise MxGraphValidationError(
                "DanglingTarget",
                f"mxCell '{cell_id}' 引用了缺失的 target '{target}'",
                cell_id=cell_id,
            )

        seen_parents = {cell_id}
        parent_cursor = (cell.get("parent") or "").strip()
        while parent_cursor:
            if parent_cursor not in cell_by_id:
                break
            if parent_cursor in seen_parents:
                raise MxGraphValidationError(
                    "ParentCycle",
                    f"mxCell '{cell_id}' 在 '{parent_cursor}' 处形成 parent 循环",
                    cell_id=cell_id,
                )
            seen_parents.add(parent_cursor)
            parent_cursor = (cell_by_id[parent_cursor].get("parent") or "").strip()

    _validate_root_vertex_page_bounds(model, cell_by_id)
    _validate_same_parent_vertex_overlaps(cell_by_id)


def get_mxgraph_validation_issue(xml: str) -> MxGraphValidationIssue | None:
    try:
        validate_mxgraph_xml(xml)
    except MxGraphValidationError as exc:
        return MxGraphValidationIssue(
            error_type=exc.error_type,
            message=exc.message,
            cell_id=exc.cell_id,
        )
    return None


def is_valid_mxgraph_xml(xml: str) -> bool:
    return get_mxgraph_validation_issue(xml) is None


def format_mxgraph_validation_error(
    issue: MxGraphValidationError | MxGraphValidationIssue, *, path: str
) -> str:
    return (
        f"错误：无效 draw.io XML（{issue.error_type}）：{issue.message}。"
        f"{path} 未写入。请修复 XML 后重试。"
    )


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法：python mxgraph_validation.py <file.drawio>")
        sys.exit(1)

    path = sys.argv[1]
    raw = open(path, encoding="utf-8").read()
    inner = extract_mxgraph_xml(raw)
    inner = normalize_mxgraph_xml(inner)
    issue = get_mxgraph_validation_issue(inner)
    if issue:
        print(format_mxgraph_validation_error(issue, path=path))
        sys.exit(1)
    else:
        print(f"通过：{path}")
