"""U4.1 — GLB ingestion + topology analysis (SPEC-12 §5.1 meshio, NFR-5 rejection)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import trimesh

from app.meshio import (
    MeshTopology,
    UnsupportedTopologyError,
    analyze,
    boundary_loops,
    detect_mode,
    load_mesh,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def _annulus() -> trimesh.Trimesh:
    """Hand-written open strip with TWO boundary loops (flat annulus, 12 tris)."""
    n = 6
    angles = 2.0 * np.pi * np.arange(n) / n
    outer = np.column_stack([2.0 * np.cos(angles), 2.0 * np.sin(angles), np.zeros(n)])
    inner = np.column_stack([np.cos(angles), np.sin(angles), np.zeros(n)])
    vertices = np.vstack([outer, inner])  # 0..5 outer, 6..11 inner
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, j, n + i])
        faces.append([n + i, j, n + j])
    return trimesh.Trimesh(vertices=vertices, faces=np.array(faces), process=False)


def _bowtie() -> trimesh.Trimesh:
    """Two triangles pinched at a single shared boundary vertex (a figure-8).

    Vertex 0 is the pinch: every edge is incident to exactly one face (all six are
    boundary edges), so no INTERIOR edge is non-manifold — but vertex 0's boundary
    neighbours are {1, 2, 3, 4} (four, not two). This drives the boundary-vertex
    guard specifically, distinct from analyze's interior-edge guard.
    """
    vertices = np.array(
        [
            [0.0, 0.0, 0.0],  # 0 — the pinch vertex (shared by both fans)
            [1.0, 1.0, 0.0],  # 1 } triangle A
            [1.0, -1.0, 0.0],  # 2 }
            [-1.0, 1.0, 0.0],  # 3 } triangle B
            [-1.0, -1.0, 0.0],  # 4 }
        ]
    )
    faces = np.array([[0, 1, 2], [0, 3, 4]])
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


# --- fixture loading -----------------------------------------------------------------


@pytest.mark.parametrize("name", ["dome.glb", "blob.glb", "torus.glb"])
def test_fixtures_load_from_bytes(name: str) -> None:
    mesh = load_mesh(_fixture_bytes(name))
    assert isinstance(mesh, trimesh.Trimesh)
    assert len(mesh.vertices) > 0
    assert len(mesh.faces) > 0


def test_load_mesh_rejects_empty_input() -> None:
    with pytest.raises(ValueError, match="empty"):
        load_mesh(b"")


def test_load_mesh_rejects_invalid_input() -> None:
    with pytest.raises(ValueError, match="invalid GLB payload"):
        load_mesh(b"this is not a glb payload")


def test_load_mesh_concatenates_scene_geometries() -> None:
    box_a = trimesh.creation.box(extents=(1.0, 1.0, 1.0))
    box_b = trimesh.creation.box(extents=(1.0, 1.0, 1.0))
    transform = np.eye(4)
    transform[:3, 3] = (5.0, 0.0, 0.0)
    scene = trimesh.Scene()
    scene.add_geometry(box_a, node_name="a", geom_name="a")
    scene.add_geometry(box_b, node_name="b", geom_name="b", transform=transform)
    mesh = load_mesh(scene.export(file_type="glb"))
    assert len(mesh.vertices) == len(box_a.vertices) + len(box_b.vertices)
    assert len(mesh.faces) == len(box_a.faces) + len(box_b.faces)
    # World transforms are baked in: box_a spans x∈[-0.5, 0.5], box_b is translated by
    # (5, 0, 0) so it spans x∈[4.5, 5.5]. The concatenated mesh must span the full range,
    # proving the geometry was placed — not just counted.
    assert mesh.vertices[:, 0].min() == pytest.approx(-0.5)
    assert mesh.vertices[:, 0].max() == pytest.approx(5.5)


# --- boundary loops ------------------------------------------------------------------


def test_dome_has_one_ordered_boundary_loop() -> None:
    mesh = load_mesh(_fixture_bytes("dome.glb"))
    loops = boundary_loops(mesh)
    assert len(loops) == 1
    loop = loops[0]
    assert len(loop) >= 3
    assert len(set(loop)) == len(loop)  # no repeated vertices
    # Every consecutive pair (including the closing wrap) is a genuine boundary edge.
    edges = mesh.edges_sorted
    unique, counts = np.unique(edges, axis=0, return_counts=True)
    boundary_set = {tuple(edge) for edge in unique[counts == 1]}
    for a, b in zip(loop, loop[1:] + loop[:1]):
        assert tuple(sorted((a, b))) in boundary_set


def test_blob_has_no_boundary_loops() -> None:
    mesh = load_mesh(_fixture_bytes("blob.glb"))
    assert boundary_loops(mesh) == []


def test_annulus_has_two_boundary_loops() -> None:
    loops = boundary_loops(_annulus())
    assert len(loops) == 2
    assert sorted(len(loop) for loop in loops) == [6, 6]


def test_boundary_loops_rejects_nonmanifold_boundary_vertex() -> None:
    """A bowtie pinches two triangles at vertex 0, giving it 4 boundary neighbours.
    boundary_loops must reject the non-manifold BOUNDARY vertex (the != 2-neighbour
    branch) — distinct from analyze's non-manifold INTERIOR-edge guard, since here
    no edge is shared by more than one face."""
    with pytest.raises(
        UnsupportedTopologyError,
        match=r"non-manifold boundary at vertex 0 \(4 boundary neighbours\)",
    ):
        boundary_loops(_bowtie())


# --- analyze -------------------------------------------------------------------------


def test_dome_analyzes_as_open_disk() -> None:
    topology = analyze(load_mesh(_fixture_bytes("dome.glb")))
    assert isinstance(topology, MeshTopology)
    assert topology.mode == "open"
    assert topology.n_boundary_loops == 1
    assert topology.euler_characteristic == 1  # disk: V - E + F = 1
    assert topology.genus == 0
    assert topology.is_closed is False
    assert topology.n_vertices > 0
    assert topology.n_faces > 0


def test_blob_analyzes_as_closed_genus_zero() -> None:
    mesh = load_mesh(_fixture_bytes("blob.glb"))
    assert mesh.is_watertight
    topology = analyze(mesh)
    assert topology.mode == "closed"
    assert topology.is_closed is True
    assert topology.genus == 0
    assert topology.euler_characteristic == 2  # sphere: V - E + F = 2
    assert topology.n_boundary_loops == 0


def test_torus_rejected_with_genus_error() -> None:
    mesh = load_mesh(_fixture_bytes("torus.glb"))
    with pytest.raises(UnsupportedTopologyError, match="genus 1"):
        analyze(mesh)


def test_two_boundary_loop_strip_rejected_with_loop_error() -> None:
    with pytest.raises(UnsupportedTopologyError, match="2 boundary loops"):
        analyze(_annulus())


def test_analyze_rejects_nonmanifold_interior_edge() -> None:
    """Three triangles fanning off a shared edge (0,1) — that edge is incident to 3 faces.
    A non-manifold INTERIOR edge must be rejected explicitly, before any genus arithmetic."""
    vertices = np.array(
        [
            [0.0, 0.0, 0.0],  # 0 } shared edge (0, 1)
            [1.0, 0.0, 0.0],  # 1 }
            [0.0, 1.0, 0.0],  # 2 fan blade A
            [0.0, -1.0, 0.0],  # 3 fan blade B
            [0.0, 0.0, 1.0],  # 4 fan blade C
        ]
    )
    faces = np.array([[0, 1, 2], [0, 1, 3], [0, 1, 4]])
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    with pytest.raises(UnsupportedTopologyError, match=r"non-manifold edge \(0, 1\) shared by 3 faces"):
        analyze(mesh)


# --- detect_mode ---------------------------------------------------------------------


def test_detect_mode_auto() -> None:
    assert detect_mode(load_mesh(_fixture_bytes("dome.glb")), "auto") == "open"
    assert detect_mode(load_mesh(_fixture_bytes("blob.glb")), "auto") == "closed"


def test_detect_mode_validates_explicit_request() -> None:
    assert detect_mode(load_mesh(_fixture_bytes("dome.glb")), "open") == "open"
    assert detect_mode(load_mesh(_fixture_bytes("blob.glb")), "closed") == "closed"


def test_detect_mode_rejects_closed_request_on_open_mesh() -> None:
    with pytest.raises(ValueError, match='requested mode "closed".*open'):
        detect_mode(load_mesh(_fixture_bytes("dome.glb")), "closed")


def test_detect_mode_rejects_open_request_on_closed_mesh() -> None:
    with pytest.raises(ValueError, match='requested mode "open".*closed'):
        detect_mode(load_mesh(_fixture_bytes("blob.glb")), "open")


def test_detect_mode_rejects_unknown_mode() -> None:
    with pytest.raises(ValueError, match="mode"):
        detect_mode(load_mesh(_fixture_bytes("dome.glb")), "bogus")


def test_detect_mode_auto_still_rejects_torus() -> None:
    with pytest.raises(UnsupportedTopologyError, match="genus"):
        detect_mode(load_mesh(_fixture_bytes("torus.glb")), "auto")
