"""GLB loading, boundary-loop/genus analysis, and mode auto-detection (SPEC-12 §5.1, FR-1 I/O boundary).

The fitting pipeline's front door: decode the GLB payload into a single triangle mesh
(multi-mesh scenes concatenated with world transforms baked in — the reconstruct
precedent), then classify its topology so the pipeline can pick a parameterization:

- ``"open"``   — disk topology: exactly one boundary loop, Euler characteristic 1.
- ``"closed"`` — watertight genus-0 (Euler characteristic 2).

Anything else (genus >= 1, multiple boundary loops) is out of v1 scope and rejected
with a clear :class:`UnsupportedTopologyError` (NFR-5). numpy/trimesh are used freely
here — meshio is an I/O boundary module, not MLX core. No RNG anywhere (NFR-1).
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
import trimesh

_SCOPE_HINT = "v1 handles a single-boundary-loop open region or a closed genus-0 mesh"


class UnsupportedTopologyError(ValueError):
    """The mesh's topology is outside SPEC-12 v1 scope (NFR-5)."""


@dataclass(frozen=True)
class MeshTopology:
    """Topology summary produced by :func:`analyze`."""

    n_vertices: int
    n_faces: int
    euler_characteristic: int
    n_boundary_loops: int
    genus: int
    is_closed: bool
    mode: str  # "open" | "closed"


def load_mesh(glb_bytes: bytes) -> trimesh.Trimesh:
    """Decode GLB bytes into a single :class:`trimesh.Trimesh`.

    Scenes are concatenated with world transforms baked in (reconstruct's
    ``load_mesh`` pattern). Raises ``ValueError`` on empty, undecodable, or
    geometry-free input.
    """
    if not glb_bytes:
        raise ValueError("empty GLB payload")
    try:
        obj = trimesh.load(io.BytesIO(glb_bytes), file_type="glb", process=False)
    except Exception as exc:
        raise ValueError(f"invalid GLB payload: {exc}") from exc
    mesh = _as_single_mesh(obj)
    if mesh is None or len(mesh.faces) == 0:
        raise ValueError("GLB contained no triangle geometry")
    return mesh


def _as_single_mesh(obj: object) -> trimesh.Trimesh | None:
    if isinstance(obj, trimesh.Trimesh):
        return obj
    if isinstance(obj, trimesh.Scene):
        if len(obj.geometry) == 0:
            return None
        # Concatenate every mesh in the scene with world transforms baked in.
        return obj.to_geometry() if hasattr(obj, "to_geometry") else obj.dump(concatenate=True)
    return None


def boundary_loops(mesh: trimesh.Trimesh) -> list[list[int]]:
    """Ordered, closed vertex loops of the mesh boundary.

    A boundary edge belongs to exactly one face. Each returned loop lists vertex
    indices in adjacency order without repeating the start vertex (the last entry
    connects back to the first). Traversal order is deterministic: loops start at
    their smallest unvisited vertex and step to the smaller-indexed neighbour first.
    """
    edges = mesh.edges_sorted
    unique, counts = np.unique(edges, axis=0, return_counts=True)
    boundary = unique[counts == 1]
    if len(boundary) == 0:
        return []

    adjacency: dict[int, set[int]] = {}
    for a, b in boundary:
        adjacency.setdefault(int(a), set()).add(int(b))
        adjacency.setdefault(int(b), set()).add(int(a))
    for vertex, neighbours in adjacency.items():
        if len(neighbours) != 2:
            raise UnsupportedTopologyError(
                f"non-manifold boundary at vertex {vertex} "
                f"({len(neighbours)} boundary neighbours) — {_SCOPE_HINT}"
            )

    remaining = set(adjacency)
    loops: list[list[int]] = []
    while remaining:
        start = min(remaining)  # deterministic loop order
        loop = [start]
        remaining.discard(start)
        previous, current = None, start
        while True:
            candidates = sorted(n for n in adjacency[current] if n != previous)
            nxt = candidates[0]
            if nxt == start:
                break
            loop.append(nxt)
            remaining.discard(nxt)
            previous, current = current, nxt
        loops.append(loop)
    return loops


def analyze(mesh: trimesh.Trimesh) -> MeshTopology:
    """Classify the mesh's topology and pick the fitting mode (SPEC-12 §5.1).

    Euler characteristic: ``chi = V - E + F``. For a closed orientable surface
    ``chi = 2 - 2g`` so ``g = (2 - chi) / 2``; with ``b`` boundary loops
    ``chi = 2 - 2g - b`` so ``g = (2 - b - chi) / 2`` (disk iff ``chi == 1`` for
    the one-boundary-loop case). Raises :class:`UnsupportedTopologyError` for
    anything outside v1 scope (NFR-5).
    """
    # Reject non-manifold interior edges (shared by 3+ faces) BEFORE trusting the
    # Euler/genus arithmetic: the boundary-vertex guard only inspects count-1 edges,
    # so an interior edge with face-incidence > 2 would otherwise skew the genus.
    edges = mesh.edges_sorted
    unique_edges, edge_counts = np.unique(edges, axis=0, return_counts=True)
    nonmanifold = edge_counts > 2
    if bool(nonmanifold.any()):
        idx = int(np.argmax(nonmanifold))
        a, b = unique_edges[idx]
        raise UnsupportedTopologyError(
            f"non-manifold edge ({int(a)}, {int(b)}) shared by {int(edge_counts[idx])} faces "
            f"— {_SCOPE_HINT}"
        )

    loops = boundary_loops(mesh)
    n_loops = len(loops)
    euler = int(len(mesh.vertices) - len(mesh.edges_unique) + len(mesh.faces))
    genus = (2 - n_loops - euler) // 2
    is_closed = n_loops == 0 and bool(mesh.is_watertight)

    if is_closed and genus == 0:
        mode = "closed"
    elif n_loops == 1 and euler == 1:
        mode = "open"
    elif genus >= 1:
        shape = "torus-like" if genus == 1 else "multi-handled"
        raise UnsupportedTopologyError(
            f"genus {genus} ({shape}) meshes are not supported in v1 — {_SCOPE_HINT}"
        )
    elif n_loops >= 2:
        raise UnsupportedTopologyError(f"{n_loops} boundary loops — {_SCOPE_HINT}")
    else:
        raise UnsupportedTopologyError(
            f"unsupported topology: {n_loops} boundary loops, Euler characteristic {euler}, "
            f"watertight={bool(mesh.is_watertight)} — {_SCOPE_HINT}"
        )

    return MeshTopology(
        n_vertices=int(len(mesh.vertices)),
        n_faces=int(len(mesh.faces)),
        euler_characteristic=euler,
        n_boundary_loops=n_loops,
        genus=genus,
        is_closed=is_closed,
        mode=mode,
    )


def detect_mode(mesh: trimesh.Trimesh, requested: str) -> str:
    """Resolve the request's ``mode`` field (§6.1: ``auto | open | closed``).

    ``"auto"`` returns :func:`analyze`'s verdict; an explicit ``"open"``/``"closed"``
    is validated against the actual topology and raises ``ValueError`` on mismatch.
    """
    if requested not in ("auto", "open", "closed"):
        raise ValueError(f'unknown mode "{requested}" — expected "auto", "open" or "closed"')
    topology = analyze(mesh)
    if requested == "auto":
        return topology.mode
    if topology.mode != requested:
        raise ValueError(
            f'requested mode "{requested}" but the mesh is {topology.mode} '
            f"({topology.n_boundary_loops} boundary loops, genus {topology.genus})"
        )
    return requested
