"""Plastiq photogrammetry service — SfM + MVS front-end (photos → poses + point cloud).

See docs/adr/0013 and SPEC-13. The multi-view-geometry core (app/core) is written fresh from the
literature (kornia's algorithms, Apache-2.0, ported with attribution); no COLMAP/pycolmap/torch at
runtime. Dense MVS raster math (app/mvs) runs on MLX; the sparse solvers run on numpy/scipy.
"""
