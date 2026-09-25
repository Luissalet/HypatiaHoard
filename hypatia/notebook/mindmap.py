"""Mind map validation/trimming: depth ≤ 4, ≤ 60 nodes, labels ≤ 80 chars, refs → real passages."""

from __future__ import annotations

from collections import deque
from typing import Any, Iterable, Optional

MAX_DEPTH = 4
MAX_NODES = 60
MAX_LABEL = 80


def _label(v: Any) -> str:
    text = " ".join(str(v or "").split())
    if len(text) > MAX_LABEL:
        text = text[: MAX_LABEL - 1].rstrip() + "…"
    return text


def _refs(v: Any, valid: Optional[set[int]]) -> list[int]:
    out: list[int] = []
    if isinstance(v, (int, str)):
        v = [v]
    if not isinstance(v, list):
        return out
    for x in v:
        try:
            n = int(str(x).strip().strip("[]"))
        except ValueError:
            continue
        if (valid is None or n in valid) and n not in out:
            out.append(n)
    return out[:6]


def _children(node: dict[str, Any]) -> list[Any]:
    for key in ("children", "hijos", "nodes", "subtopics"):
        v = node.get(key)
        if isinstance(v, list):
            return v
    return []


def validate(raw: Any, valid_refs: Optional[Iterable[int]] = None, fallback_label: str = "Mapa") -> dict[str, Any]:
    """Return a clean tree {label, children, refs?}; never raises."""
    valid = set(valid_refs) if valid_refs is not None else None
    if isinstance(raw, list):
        raw = {"label": fallback_label, "children": raw}
    if not isinstance(raw, dict):
        return {"label": _label(fallback_label), "children": []}
    if "label" not in raw:
        for key in ("root", "mindmap", "map"):
            if isinstance(raw.get(key), dict):
                raw = raw[key]
                break
    root: dict[str, Any] = {"label": _label(raw.get("label") or raw.get("title") or fallback_label) or "Mapa",
                            "children": []}
    refs = _refs(raw.get("refs"), valid)
    if refs:
        root["refs"] = refs
    count = 1
    # breadth-first so that trimming at 60 nodes drops the deepest/last details first
    queue: deque[tuple[dict[str, Any], Any, int]] = deque((root, c, 2) for c in _children(raw))
    while queue and count < MAX_NODES:
        parent, node, depth = queue.popleft()
        if isinstance(node, str):
            node = {"label": node}
        if not isinstance(node, dict):
            continue
        label = _label(node.get("label") or node.get("title") or node.get("name"))
        if not label:
            continue
        clean: dict[str, Any] = {"label": label, "children": []}
        r = _refs(node.get("refs"), valid)
        if r:
            clean["refs"] = r
        parent["children"].append(clean)
        count += 1
        if depth < MAX_DEPTH:
            queue.extend((clean, c, depth + 1) for c in _children(node))
    return root


def count_nodes(tree: dict[str, Any]) -> int:
    return 1 + sum(count_nodes(c) for c in tree.get("children", []))


def depth(tree: dict[str, Any]) -> int:
    kids = tree.get("children", [])
    return 1 + (max(depth(c) for c in kids) if kids else 0)


def to_markdown(tree: dict[str, Any]) -> str:
    lines = [f"# {tree['label']}"]

    def walk(node: dict[str, Any], level: int) -> None:
        for c in node.get("children", []):
            refs = "".join(f"[{n}]" for n in c.get("refs", []))
            lines.append(f"{'  ' * level}- {c['label']}{(' ' + refs) if refs else ''}")
            walk(c, level + 1)

    walk(tree, 0)
    return "\n".join(lines)


def all_refs(tree: dict[str, Any]) -> list[int]:
    out: list[int] = list(tree.get("refs", []))
    for c in tree.get("children", []):
        out.extend(all_refs(c))
    return sorted(set(out))
