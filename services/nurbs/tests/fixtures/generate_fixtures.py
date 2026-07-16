"""Deterministic generator for the tiny GLB topology fixtures (SPEC-12 U4.1).

Run as a script to (re)write the three fixtures next to this file:

- ``dome.glb``  — an open hemisphere cut from an icosphere: disk topology,
  exactly one boundary loop (verified before writing), Euler characteristic 1.
- ``blob.glb``  — a closed genus-0 mesh that is NOT a perfect sphere: icosphere
  vertices radially modulated by ``r *= 1 + 0.15*sin(3*theta)*cos(2*phi)`` and
  scaled anisotropically by (1.0, 0.8, 1.3). Watertight (verified).
- ``torus.glb`` — a coarse genus-1 torus (verified Euler characteristic 0).

No RNG anywhere — every vertex position is a closed-form function of the
icosphere/torus tessellation, so reruns are bit-for-bit reproducible.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import trimesh

FIXTURE_DIR = Path(__file__).resolve().parent


def _boundary_loop_count(mesh: trimesh.Trimesh) -> int:
    """Count closed loops of boundary edges (edges used by exactly one face).

    Self-contained on purpose: the generator must not import ``app.meshio``
    (the code under test) to validate its own output.
    """
    edges = mesh.edges_sorted
    unique, counts = np.unique(edges, axis=0, return_counts=True)
    boundary = unique[counts == 1]
    if len(boundary) == 0:
        return 0
    adjacency: dict[int, set[int]] = {}
    for a, b in boundary:
        adjacency.setdefault(int(a), set()).add(int(b))
        adjacency.setdefault(int(b), set()).add(int(a))
    # A manifold boundary vertex has exactly two boundary neighbours.
    for vertex, neighbours in adjacency.items():
        if len(neighbours) != 2:
            raise ValueError(f"non-manifold boundary at vertex {vertex}: {len(neighbours)} neighbours")
    remaining = set(adjacency)
    loops = 0
    while remaining:
        start = min(remaining)  # deterministic traversal order
        previous, current = None, start
        while True:
            remaining.discard(current)
            step = sorted(n for n in adjacency[current] if n != previous)
            nxt = step[0] if step[0] != previous else step[-1]
            previous, current = current, nxt
            if current == start:
                break
        loops += 1
    return loops


def _euler_characteristic(mesh: trimesh.Trimesh) -> int:
    return int(len(mesh.vertices) - len(mesh.edges_unique) + len(mesh.faces))


def make_dome() -> trimesh.Trimesh:
    """Open hemisphere: icosphere faces whose vertices all satisfy z >= -1e-9."""
    sphere = trimesh.creation.icosphere(subdivisions=2, radius=1.0)
    keep = (sphere.vertices[sphere.faces][:, :, 2] >= -1e-9).all(axis=1)
    dome = trimesh.Trimesh(vertices=sphere.vertices.copy(), faces=sphere.faces[keep], process=False)
    dome.remove_unreferenced_vertices()  # re-index to the kept faces only
    loops = _boundary_loop_count(dome)
    euler = _euler_characteristic(dome)
    if loops != 1 or euler != 1:
        raise ValueError(f"dome is not a disk: {loops} boundary loops, euler {euler}")
    return dome


def make_blob() -> trimesh.Trimesh:
    """Closed genus-0 blob: smoothly modulated, anisotropically scaled icosphere."""
    sphere = trimesh.creation.icosphere(subdivisions=2, radius=1.0)
    v = sphere.vertices
    r = np.linalg.norm(v, axis=1)
    theta = np.arccos(np.clip(v[:, 2] / r, -1.0, 1.0))  # polar angle
    phi = np.arctan2(v[:, 1], v[:, 0])  # azimuth
    modulation = 1.0 + 0.15 * np.sin(3.0 * theta) * np.cos(2.0 * phi)
    vertices = v * modulation[:, None] * np.array([1.0, 0.8, 1.3])
    blob = trimesh.Trimesh(vertices=vertices, faces=sphere.faces.copy(), process=False)
    euler = _euler_characteristic(blob)
    if not blob.is_watertight or euler != 2:
        raise ValueError(f"blob is not closed genus-0: watertight={blob.is_watertight}, euler {euler}")
    return blob


def make_torus() -> trimesh.Trimesh:
    """Coarse genus-1 torus (Euler characteristic 0)."""
    torus = trimesh.creation.torus(
        major_radius=1.0, minor_radius=0.3, major_sections=12, minor_sections=8
    )
    euler = _euler_characteristic(torus)
    if not torus.is_watertight or euler != 0:
        raise ValueError(f"torus is not closed genus-1: watertight={torus.is_watertight}, euler {euler}")
    return torus


def main() -> None:
    for name, builder in (("dome", make_dome), ("blob", make_blob), ("torus", make_torus)):
        mesh = builder()
        path = FIXTURE_DIR / f"{name}.glb"
        path.write_bytes(mesh.export(file_type="glb"))
        print(f"wrote {path.name}: {len(mesh.vertices)} vertices, {len(mesh.faces)} faces, "
              f"{path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
