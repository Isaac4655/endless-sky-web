#!/usr/bin/env python3
"""Generate bounded-memory web resources for Endless Sky.

IMPORTANT: Endless Sky's data format is indentation-based, not brace-based.
This generator therefore parses the data tree by indentation and preserves the
meaningful node hierarchy before splitting system data into lightweight and
runtime-heavy resources.

Outputs:
  <output>/global.txt
      Every top-level data node except system definitions and system topology
      (link/unlink).

  <output>/systems.index.txt
      Lightweight system definitions plus top-level link/unlink operations,
      preserving original file/node order.

  <output>/systems/<hex-utf8-system-name>.txt
      Runtime-heavy direct children for each system. Only heavy children are
      included here; lightweight navigation/system-object data remains in the
      index resource.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from pathlib import Path
import re
from typing import Iterable, List, Optional, Tuple

HEAVY_SYSTEM_KEYS = {
    "asteroids",
    "minables",
    "fleet",
    "hazard",
    "raid",
    "belt",
}


@dataclass
class Node:
    """A single Endless Sky data node with its children."""

    content: str
    indent: int
    children: List["Node"] = field(default_factory=list)

    def render(self, depth: int = 0) -> str:
        lines = ["\t" * depth + self.content]
        lines.extend(child.render(depth + 1) for child in self.children)
        return "\n".join(lines)

    def clone(self) -> "Node":
        return Node(self.content, self.indent, [child.clone() for child in self.children])


def _indent_width(prefix: str) -> int:
    # Endless Sky convention is tabs. Expanding tabs makes the parser robust to
    # files which have accidentally mixed tabs and spaces while preserving order.
    return len(prefix.expandtabs(8))


def _is_comment_or_blank(line: str) -> bool:
    stripped = line.lstrip()
    return not stripped or stripped.startswith("#") or stripped.startswith("//")


def parse_nodes(text: str) -> List[Node]:
    """Parse an Endless Sky data file using indentation-based hierarchy."""
    roots: List[Node] = []
    # Stack entries are (indent width, node). The stack contains the current
    # ancestor chain.
    stack: List[Tuple[int, Node]] = []

    for raw_line in text.splitlines():
        if _is_comment_or_blank(raw_line):
            continue

        match = re.match(r"^[ \t]*", raw_line)
        prefix = match.group(0)
        indent = _indent_width(prefix)
        content = raw_line[len(prefix):].rstrip()
        if not content:
            continue

        node = Node(content=content, indent=indent)

        while stack and indent <= stack[-1][0]:
            stack.pop()

        if stack:
            stack[-1][1].children.append(node)
        else:
            roots.append(node)

        stack.append((indent, node))

    return roots


def tokenize_header(text: str) -> List[str]:
    """Tokenize one Endless Sky node header.

    Handles both double-quoted tokens and backtick tokens. Quotes are removed,
    matching the semantic token behavior used by DataNode sufficiently for this
    generator's key/name decisions.
    """
    tokens: List[str] = []
    current: List[str] = []
    quote: Optional[str] = None
    escaped = False

    for ch in text.strip():
        if quote is not None:
            if quote == '"' and escaped:
                current.append(ch)
                escaped = False
            elif quote == '"' and ch == "\\":
                escaped = True
            elif ch == quote:
                quote = None
            else:
                current.append(ch)
            continue

        if ch in ('"', '`'):
            quote = ch
        elif ch.isspace():
            if current:
                tokens.append("".join(current))
                current.clear()
        else:
            current.append(ch)

    if current:
        tokens.append("".join(current))
    return tokens


def node_tokens(node: Node) -> List[str]:
    return tokenize_header(node.content)


def node_key(node: Node) -> str:
    tokens = node_tokens(node)
    if not tokens:
        return ""

    if tokens[0] in {"add", "remove"} and len(tokens) > 1:
        if tokens[1] == "raid" and len(tokens) > 2 and tokens[2] == "fleet":
            return "raid"
        return tokens[1]

    if tokens[0] == "raid" and len(tokens) > 1 and tokens[1] == "fleet":
        return "raid"

    return tokens[0]


def system_name(node: Node) -> str:
    tokens = node_tokens(node)
    if len(tokens) < 2 or tokens[0] != "system":
        raise ValueError(f"Could not determine system name from node: {node.content!r}")
    return tokens[1]


def system_root(node: Node) -> bool:
    return node_key(node) == "system"


def lightweight_system(node: Node, runtime_available: bool) -> Node:
    """Copy a system while removing runtime-heavy direct children."""
    out = Node(node.content, node.indent)
    out.children.append(Node(
        "web runtime available" if runtime_available else "web runtime unavailable",
        node.indent + 1,
    ))
    for child in node.children:
        if node_key(child) in HEAVY_SYSTEM_KEYS:
            continue
        out.children.append(child.clone())
    return out


def runtime_system(node: Node, reset_before: bool = False) -> Optional[Node]:
    """Return only runtime-heavy direct children for one system definition."""
    out = Node(node.content, node.indent)
    if reset_before:
        out.children.append(Node("web runtime clear", node.indent + 1))
    for child in node.children:
        if node_key(child) in HEAVY_SYSTEM_KEYS:
            out.children.append(child.clone())
    return out if out.children else None


def system_hex_name(name: str) -> str:
    return name.encode("utf-8").hex()


def read_data_files(data_root: Path, excluded_root: Optional[Path] = None) -> Iterable[Tuple[Path, str]]:
    files = sorted(p for p in data_root.rglob("*.txt") if p.is_file())
    if excluded_root is not None:
        excluded_root = excluded_root.resolve()
        filtered: List[Path] = []
        for path in files:
            resolved = path.resolve()
            try:
                resolved.relative_to(excluded_root)
                continue
            except ValueError:
                pass
            filtered.append(path)
        files = filtered

    for path in files:
        yield path, path.read_text(encoding="utf-8")


def join_nodes(nodes: Iterable[Node]) -> str:
    rendered = [node.render() for node in nodes]
    return ("\n\n".join(rendered) + "\n") if rendered else ""


def generate(data_root: Path, output_root: Path) -> None:
    data_root = data_root.resolve()
    output_root = output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    systems_dir = output_root / "systems"
    systems_dir.mkdir(parents=True, exist_ok=True)

    global_nodes: List[Node] = []
    index_nodes: List[Node] = []

    # Each system name can have multiple definitions across files. Preserve
    # original definition order so overwrite semantics remain reconstructible.
    system_nodes: dict[str, List[Node]] = {}
    system_order: List[str] = []

    for path, text in read_data_files(data_root, output_root):
        pending_overwrite = False

        for node in parse_nodes(text):
            key = node_key(node)

            if key == "overwrite":
                pending_overwrite = True
                continue

            if key == "system":
                name = system_name(node)
                if name not in system_nodes:
                    system_nodes[name] = []
                    system_order.append(name)

                if pending_overwrite:
                    overwrite_node = Node("overwrite", node.indent)
                    index_nodes.append(overwrite_node)
                    system_nodes[name].append(overwrite_node.clone())
                    pending_overwrite = False

                system_nodes[name].append(node.clone())
                continue

            if key in {"link", "unlink"} and len(node_tokens(node)) >= 3:
                # Links are part of the lightweight galaxy topology and must
                # stay in the system index in their original position.
                index_nodes.append(node.clone())
                pending_overwrite = False
                continue

            if pending_overwrite:
                global_nodes.append(Node("overwrite", node.indent))
                pending_overwrite = False
            global_nodes.append(node.clone())

        # UniverseObjects::LoadFile resets overwrite after each input node; an
        # unmatched root overwrite cannot leak into the next input file.
        pending_overwrite = False

    # Build runtime chunks from the collected system definitions.
    runtime_chunks: dict[str, List[Node]] = {}
    for name in system_order:
        runtime_nodes: List[Node] = []
        pending_reset = False
        for node in system_nodes[name]:
            key = node_key(node)
            if key == "overwrite":
                pending_reset = True
                continue

            runtime = runtime_system(node, reset_before=pending_reset)
            pending_reset = False
            if runtime is not None:
                runtime_nodes.append(runtime)

        if runtime_nodes:
            runtime_chunks[name] = runtime_nodes

    # Rebuild the index system definitions in original global order.
    # The first implementation appended system nodes directly above; because
    # runtime availability is known only after collecting all systems, we need
    # to reconstruct only the system entries while leaving links/unlinks and
    # overwrite nodes where they occurred.
    #
    # We therefore re-parse the source tree in order for the final index.
    final_index: List[Node] = []
    for path, text in read_data_files(data_root, output_root):
        pending_overwrite = False
        for node in parse_nodes(text):
            key = node_key(node)
            if key == "overwrite":
                pending_overwrite = True
                continue
            if key == "system":
                name = system_name(node)
                if pending_overwrite:
                    final_index.append(Node("overwrite", node.indent))
                    pending_overwrite = False
                final_index.append(lightweight_system(node, name in runtime_chunks))
            elif key in {"link", "unlink"} and len(node_tokens(node)) >= 3:
                final_index.append(node.clone())
                pending_overwrite = False
        # Do not leak overwrite across files.

    (output_root / "global.txt").write_text(join_nodes(global_nodes), encoding="utf-8")
    (output_root / "systems.index.txt").write_text(join_nodes(final_index), encoding="utf-8")

    # Remove stale chunks from a previous generation. This is important when a
    # system becomes runtime-light or is removed from the source tree.
    expected = {systems_dir / f"{system_hex_name(name)}.txt" for name in runtime_chunks}
    for existing in systems_dir.glob("*.txt"):
        if existing not in expected:
            existing.unlink()

    for name, nodes in runtime_chunks.items():
        destination = systems_dir / f"{system_hex_name(name)}.txt"
        destination.write_text(join_nodes(nodes), encoding="utf-8")

    print(f"Generated {len(system_order)} streamed systems.")
    print(f"Global data: {output_root / 'global.txt'}")
    print(f"System index: {output_root / 'systems.index.txt'}")
    print(f"System chunks: {systems_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Endless Sky WASM streaming data")
    parser.add_argument("data_root", type=Path, help="Original Endless Sky data directory")
    parser.add_argument("output_root", type=Path, help="Output web-streaming directory")
    args = parser.parse_args()
    generate(args.data_root, args.output_root)


if __name__ == "__main__":
    main()