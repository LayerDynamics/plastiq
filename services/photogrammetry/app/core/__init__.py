"""Multi-view-geometry core: features, matching, epipolar geometry, RANSAC, PnP, triangulation,
bundle adjustment, and Brown-Conrady distortion. Written fresh from the literature (kornia's
algorithms, Apache-2.0, ported with attribution). Sparse solvers are numpy/scipy float64; the
feature/matching raster math is MLX float32 (docs/adr/0013 D-9).
"""
