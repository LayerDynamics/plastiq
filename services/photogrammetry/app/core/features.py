"""Scale-space DoG keypoint detector (classical Lowe SIFT scale space) — the P1.2 detector floor.

A from-scratch reimplementation of Lowe's scale-invariant keypoint *detector*: a Gaussian scale-space
pyramid, its Difference-of-Gaussians (DoG), local extrema over ``(x, y, scale)`` on 3σ-sampled
intervals, low-contrast + Harris/Hessian edge (principal-curvature-ratio) rejection, quadratic
sub-pixel refinement, and a dominant-gradient-orientation assignment (multi-peak → duplicate
keypoints). The output is a :class:`Keypoints` record — numpy arrays of ``xy`` (original-image
pixels, ``x`` = column / ``y`` = row), absolute ``scale`` (Gaussian σ in original pixels),
``orientation`` (radians in ``[0, 2π)``) and ``response`` (``|D̂|`` contrast) — sorted by response,
capped at ``max_features``.

Numerics (docs/adr/0013 D-9): the heavy raster math — Gaussian blur, DoG, gradient/orientation maps
and the 3×3×3 neighbourhood extrema comparison — runs in ``mlx.core`` **float32** on the GPU with
gather + elementwise ``maximum``/``minimum`` only (no scatter — scatter is non-deterministic); the
comparatively cheap per-keypoint bookkeeping (sub-pixel solve, edge test, orientation histogram)
runs in float64 numpy. There is no RNG anywhere and the traversal / tie-break order is fixed, so two
``detect`` runs on the same image return identical arrays (D-10). OpenCV is a *test-only* oracle
(D-1) and is never imported here.

The Gaussian-pyramid, gradient-map and scale-space builders are public so the P1.3 SIFT *descriptor*
(appended to this same file) can reuse them without recomputation.

Algorithm reimplemented (no code copied) with attribution: Lowe, *Distinctive Image Features from
Scale-Invariant Keypoints*, IJCV 2004; the weight-free kornia references
``kornia/feature/scale_space_detector.py``, ``kornia/feature/responses.py`` and
``kornia/feature/siftdesc.py`` (Apache-2.0), which in turn follow Lowe and OpenCV's ``sift.dispatch``.
"""

from __future__ import annotations

from dataclasses import dataclass

import mlx.core as mx
import numpy as np

# --- Lowe/OpenCV scale-space constants ---------------------------------------------------------
_SIGMA = 1.6  # base Gaussian σ of the first layer in each octave (Lowe)
_ASSUMED_BLUR = 0.5  # blur already present in the input (camera/optics)
_N_SCALES = 3  # S: DoG intervals searched per octave (needs S + 3 Gaussian layers); OpenCV default
_CONTRAST_THRESHOLD = 0.04  # |D̂| · S must exceed this after refinement (Lowe/OpenCV default)
_EDGE_THRESHOLD = 10.0  # principal-curvature ratio r; reject if tr²/det ≥ (r+1)²/r
_IMG_BORDER = 5  # keypoints within this many px of an octave edge are dropped
_MAX_INTERP_STEPS = 5  # sub-pixel Newton steps before giving up
_MIN_OCTAVE_SIZE = 2 * _IMG_BORDER + 3  # stop building octaves below this (needs a 3×3 interior)

# --- orientation-histogram constants (Lowe §5) -------------------------------------------------
_ORI_BINS = 36
_ORI_RADIUS_FCTR = 3.0  # window radius = round(fctr · σ_octave)
_ORI_SIG_FCTR = 1.5  # Gaussian weighting σ = fctr · σ_octave
_ORI_PEAK_RATIO = 0.8  # secondary peaks ≥ this fraction of the max spawn extra orientations

# --- SIFT descriptor constants (Lowe §6; OpenCV sift.dispatch calcSIFTDescriptor) --------------
_DESCR_WIDTH = 4  # d: the descriptor is a d×d grid of subregions
_DESCR_HIST_BINS = 8  # n: gradient-orientation bins per subregion → 128-d descriptor
_DESCR_SCL_FCTR = 3.0  # each subregion spans this many σ (octave-local) pixels
_DESCR_MAG_THR = 0.2  # clip each normalized component to this before renormalizing (Lowe §6.1)
_DESCR_EXP_SCALE = -1.0 / (_DESCR_WIDTH * _DESCR_WIDTH * 0.5)  # Gaussian window falloff (= -1/8)
_DESCR_BINS_PER_DEG = _DESCR_HIST_BINS / 360.0  # gradient-orientation degrees → histogram bins
_SQRT2 = 1.4142135623730951

__all__ = [
    "Keypoints",
    "ScaleSpace",
    "to_grayscale",
    "gaussian_blur",
    "build_scale_space",
    "gradient_maps",
    "detect",
    "compute_descriptors",
    "detect_and_describe",
]


@dataclass
class Keypoints:
    """Detected keypoints as parallel numpy arrays, sorted by descending ``response``.

    ``xy`` is ``(x = column, y = row)`` in original-image pixels; ``scale`` is the absolute Gaussian
    σ in original-image pixels; ``orientation`` is radians in ``[0, 2π)``; ``response`` is the
    refined DoG contrast ``|D̂|``.
    """

    xy: np.ndarray  # (K, 2) float64
    scale: np.ndarray  # (K,) float64
    orientation: np.ndarray  # (K,) float64 radians
    response: np.ndarray  # (K,) float64


@dataclass
class ScaleSpace:
    """A built Gaussian + DoG scale-space pyramid (reused by the P1.3 descriptor).

    ``gaussian[o]`` is an ``(S+3, h_o, w_o)`` float32 MLX array of Gaussian-blurred layers for octave
    ``o``; ``dog[o]`` is the ``(S+2, h_o, w_o)`` layer-to-layer difference. ``octave_scale(o)`` maps
    octave-``o`` pixels to original-image pixels.
    """

    gaussian: list  # list[mx.array] (S+3, h_o, w_o)
    dog: list  # list[mx.array] (S+2, h_o, w_o)
    n_octaves: int
    n_scales: int  # S
    sigma: float
    first_octave: int  # 0, or -1 when the base image was doubled

    def octave_scale(self, octave: int) -> float:
        """Original-image pixels per octave-``octave`` pixel (``2**(octave + first_octave)``)."""
        return float(2.0 ** (octave + self.first_octave))


# --- grayscale + Gaussian blur (MLX float32 raster) --------------------------------------------


def to_grayscale(image) -> np.ndarray:
    """Convert an RGB ``(H, W, 3)`` or grayscale ``(H, W)`` uint8/float image to float32 ``[0, 1]``.

    RGB uses the Rec.601 luma weights (the OpenCV/PIL default) so grayscale inputs and their RGB
    forms are treated consistently.
    """
    arr = np.asarray(image)
    was_integer = np.issubdtype(arr.dtype, np.integer)
    if arr.ndim == 3:
        if arr.shape[2] == 1:
            arr = arr[:, :, 0]
        else:
            weights = np.array([0.299, 0.587, 0.114], dtype=np.float64)
            arr = arr[:, :, :3].astype(np.float64) @ weights
    elif arr.ndim != 2:
        raise ValueError(f"image must be (H, W) or (H, W, C); got shape {arr.shape}")
    gray = arr.astype(np.float32)
    # integer inputs are 0..255; float inputs are assumed already in [0, 1] unless clearly 0..255
    if was_integer or gray.max() > 1.0:
        gray = gray / np.float32(255.0)
    return gray


def _gaussian_kernel1d(sigma: float) -> mx.array:
    """A normalized 1-D Gaussian kernel; radius = ``ceil(3σ)`` (Lowe's 3σ support)."""
    radius = max(1, int(np.ceil(3.0 * sigma)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x * x) / (2.0 * sigma * sigma))
    k = k / k.sum()
    return mx.array(k.astype(np.float32))


def gaussian_blur(img: mx.array, sigma: float) -> mx.array:
    """Separable Gaussian blur of a 2-D ``(H, W)`` float32 MLX image with edge (replicate) borders.

    Two 1-D ``conv2d`` passes (horizontal then vertical); edge padding avoids the dark-border bias a
    zero pad would introduce. Returns a ``(H, W)`` float32 array.
    """
    if sigma <= 1e-6:
        return img
    k = _gaussian_kernel1d(sigma)
    r = k.shape[0] // 2
    x = img[None, :, :, None]  # NHWC, single channel
    # horizontal pass: weight (1, 1, ksize, 1)
    xp = mx.pad(x, [(0, 0), (0, 0), (r, r), (0, 0)], mode="edge")
    wh = k.reshape(1, 1, -1, 1)
    x = mx.conv2d(xp, wh, stride=1, padding=0)
    # vertical pass: weight (1, ksize, 1, 1)
    xp = mx.pad(x, [(0, 0), (r, r), (0, 0), (0, 0)], mode="edge")
    wv = k.reshape(1, -1, 1, 1)
    x = mx.conv2d(xp, wv, stride=1, padding=0)
    return x[0, :, :, 0]


def _resize_half(img: mx.array) -> mx.array:
    """Down-sample by 2 by nearest-neighbour decimation (``dst[i, j] = src[2i, 2j]``) — Lowe's next
    octave base taken from the ``σ = 2·sigma`` layer, already anti-aliased by its own blur."""
    return img[::2, ::2]


def _resize_double(img: mx.array) -> mx.array:
    """Up-sample by 2 with bilinear interpolation (the SIFT ``double_image`` base)."""
    h, w = img.shape
    ys = (mx.arange(2 * h, dtype=mx.float32) - 0.5) / 2.0
    xs = (mx.arange(2 * w, dtype=mx.float32) - 0.5) / 2.0
    ys = mx.clip(ys, 0.0, float(h - 1))
    xs = mx.clip(xs, 0.0, float(w - 1))
    y0 = mx.floor(ys).astype(mx.int32)
    x0 = mx.floor(xs).astype(mx.int32)
    y1 = mx.minimum(y0 + 1, h - 1)
    x1 = mx.minimum(x0 + 1, w - 1)
    wy = (ys - y0.astype(mx.float32))[:, None]
    wx = (xs - x0.astype(mx.float32))[None, :]
    c00 = img[y0][:, x0]
    c01 = img[y0][:, x1]
    c10 = img[y1][:, x0]
    c11 = img[y1][:, x1]
    top = c00 * (1 - wx) + c01 * wx
    bot = c10 * (1 - wx) + c11 * wx
    return top * (1 - wy) + bot * wy


def build_scale_space(image, sigma: float = _SIGMA, n_scales: int = _N_SCALES,
                      double_image: bool = True) -> ScaleSpace:
    """Build the Gaussian + DoG scale-space pyramid from an image (SPEC-13 §5.4-1).

    Each octave holds ``n_scales + 3`` Gaussian layers at σ = ``sigma · 2**(l / n_scales)``; the next
    octave's base is the layer at index ``n_scales`` decimated by 2. With ``double_image`` the base
    image is up-sampled ×2 first (``first_octave = -1``) for extra fine-scale keypoints on small
    inputs.
    """
    gray = to_grayscale(image)
    base = mx.array(gray)
    first_octave = 0
    if double_image:
        base = _resize_double(base)
        # the doubled image has ~2·assumed_blur; blur up to sigma
        first_octave = -1
        diff = np.sqrt(max(sigma ** 2 - (2.0 * _ASSUMED_BLUR) ** 2, 0.01))
        base = gaussian_blur(base, float(diff))
    else:
        diff = np.sqrt(max(sigma ** 2 - _ASSUMED_BLUR ** 2, 0.01))
        base = gaussian_blur(base, float(diff))

    # incremental blur increments so layer l reaches sigma·k**l from layer l-1
    k = 2.0 ** (1.0 / n_scales)
    n_layers = n_scales + 3
    increments = [0.0]
    for l in range(1, n_layers):
        s_prev = sigma * (k ** (l - 1))
        s_curr = sigma * (k ** l)
        increments.append(float(np.sqrt(max(s_curr ** 2 - s_prev ** 2, 0.0))))

    # number of octaves: keep halving until the interior can no longer hold a 3×3 neighbourhood
    h0, w0 = base.shape
    n_octaves = 1
    hh, ww = h0, w0
    while min(hh // 2, ww // 2) >= _MIN_OCTAVE_SIZE:
        n_octaves += 1
        hh, ww = hh // 2, ww // 2

    gaussian: list = []
    dog: list = []
    cur = base
    for _o in range(n_octaves):
        layers = [cur]
        for l in range(1, n_layers):
            layers.append(gaussian_blur(layers[-1], increments[l]))
        stack = mx.stack(layers, axis=0)  # (n_layers, h, w)
        dstack = stack[1:] - stack[:-1]  # (n_layers-1, h, w) DoG
        mx.eval(stack, dstack)
        gaussian.append(stack)
        dog.append(dstack)
        cur = _resize_half(layers[n_scales])  # next octave base = σ=2·sigma layer, decimated

    return ScaleSpace(gaussian=gaussian, dog=dog, n_octaves=n_octaves,
                      n_scales=n_scales, sigma=sigma, first_octave=first_octave)


# --- gradient maps (MLX float32 raster) --------------------------------------------------------


def gradient_maps(img: mx.array) -> tuple[np.ndarray, np.ndarray]:
    """Central-difference gradient magnitude + orientation maps of a 2-D image (edge borders).

    Returns ``(magnitude, orientation)`` as float32 numpy arrays of the input shape; orientation is
    ``atan2(dy, dx)`` in radians with ``dy`` pointing up (row-decreasing), the SIFT convention.
    """
    p = mx.pad(img, [(1, 1), (1, 1)], mode="edge")
    dx = p[1:-1, 2:] - p[1:-1, :-2]
    dy = p[:-2, 1:-1] - p[2:, 1:-1]  # up minus down (rows increase downward)
    mag = mx.sqrt(dx * dx + dy * dy)
    ori = mx.arctan2(dy, dx)
    mx.eval(mag, ori)
    return np.array(mag), np.array(ori)


# --- scale-space extrema (MLX comparison → numpy bookkeeping) ----------------------------------


def _extrema_mask(below: mx.array, center: mx.array, above: mx.array,
                  threshold: float) -> np.ndarray:
    """Strict 3×3×3 local extrema of ``center`` vs. its 26 neighbours across the three DoG layers.

    Pure elementwise ``maximum``/``minimum`` over sliced neighbour views (no scatter). Returns a
    boolean ``(h, w)`` numpy mask (border pixels are always False).
    """
    h, w = center.shape
    center_int = center[1:h - 1, 1:w - 1]
    nmax = None
    nmin = None
    for lvl in (below, center, above):
        same = lvl is center
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if same and dy == 0 and dx == 0:
                    continue
                nb = lvl[1 + dy:h - 1 + dy, 1 + dx:w - 1 + dx]
                nmax = nb if nmax is None else mx.maximum(nmax, nb)
                nmin = nb if nmin is None else mx.minimum(nmin, nb)
    is_max = (center_int > nmax) & (center_int > threshold)
    is_min = (center_int < nmin) & (center_int < -threshold)
    mask = np.zeros((h, w), dtype=bool)
    inner = np.array(is_max | is_min)
    mask[1:h - 1, 1:w - 1] = inner
    return mask


def _localize(dog_np: np.ndarray, layer: int, row: int, col: int, n_scales: int,
              contrast_threshold: float, edge_threshold: float):
    """Quadratic sub-pixel refinement + contrast/edge rejection (OpenCV ``adjustLocalExtrema``).

    Iterates a 3-D Newton step on ``(x, y, σ)`` up to ``_MAX_INTERP_STEPS``; rejects low-contrast and
    edge-like extrema. Returns ``(layer_f, row_f, col_f, response)`` in octave coordinates or None.
    Operates on the float64 DoG stack — cheap per-keypoint bookkeeping.
    """
    _, h, w = dog_np.shape
    dxx = dyy = dxy = 0.0
    off = np.zeros(3)
    grad = np.zeros(3)
    for _step in range(_MAX_INTERP_STEPS):
        img = dog_np[layer]
        prev = dog_np[layer - 1]
        nxt = dog_np[layer + 1]
        grad = 0.5 * np.array([
            img[row, col + 1] - img[row, col - 1],
            img[row + 1, col] - img[row - 1, col],
            nxt[row, col] - prev[row, col],
        ])
        v2 = 2.0 * img[row, col]
        dxx = img[row, col + 1] + img[row, col - 1] - v2
        dyy = img[row + 1, col] + img[row - 1, col] - v2
        dss = nxt[row, col] + prev[row, col] - v2
        dxy = 0.25 * (img[row + 1, col + 1] - img[row + 1, col - 1]
                      - img[row - 1, col + 1] + img[row - 1, col - 1])
        dxs = 0.25 * (nxt[row, col + 1] - nxt[row, col - 1]
                      - prev[row, col + 1] + prev[row, col - 1])
        dys = 0.25 * (nxt[row + 1, col] - nxt[row - 1, col]
                      - prev[row + 1, col] + prev[row - 1, col])
        hess = np.array([[dxx, dxy, dxs], [dxy, dyy, dys], [dxs, dys, dss]])
        try:
            solved = np.linalg.solve(hess, grad)
        except np.linalg.LinAlgError:
            return None
        off = -solved  # (dx, dy, dσ)
        if np.all(np.abs(off) < 0.5):
            break
        col += int(round(off[0]))
        row += int(round(off[1]))
        layer += int(round(off[2]))
        if (layer < 1 or layer > n_scales
                or row < _IMG_BORDER or row >= h - _IMG_BORDER
                or col < _IMG_BORDER or col >= w - _IMG_BORDER):
            return None
    else:
        return None  # never converged into the ±0.5 cell

    contr = dog_np[layer, row, col] + 0.5 * float(grad @ off)
    if abs(contr) * n_scales < contrast_threshold:
        return None
    tr = dxx + dyy
    det = dxx * dyy - dxy * dxy
    if det <= 0.0 or tr * tr * edge_threshold >= (edge_threshold + 1.0) ** 2 * det:
        return None
    return layer + off[2], row + off[1], col + off[0], abs(contr)


def _orientations(mag: np.ndarray, ori: np.ndarray, row: int, col: int,
                  scl_octv: float) -> list:
    """Dominant gradient orientation(s) at ``(row, col)`` — a 36-bin weighted histogram (Lowe §5).

    Returns radians in ``[0, 2π)``: the global peak plus any secondary peak ≥ ``_ORI_PEAK_RATIO`` of
    it, each parabolically interpolated.
    """
    h, w = mag.shape
    radius = int(round(_ORI_RADIUS_FCTR * scl_octv))
    weight_sigma = _ORI_SIG_FCTR * scl_octv
    expf = -1.0 / (2.0 * weight_sigma * weight_sigma)
    hist = np.zeros(_ORI_BINS, dtype=np.float64)
    for i in range(-radius, radius + 1):
        y = row + i
        if y < 1 or y >= h - 1:
            continue
        for j in range(-radius, radius + 1):
            x = col + j
            if x < 1 or x >= w - 1:
                continue
            if i * i + j * j > radius * radius:
                continue
            weight = np.exp((i * i + j * j) * expf)
            deg = np.rad2deg(ori[y, x]) % 360.0
            bin_idx = int(round(deg * _ORI_BINS / 360.0)) % _ORI_BINS
            hist[bin_idx] += weight * mag[y, x]

    # circular smoothing (OpenCV's 1-4-6-4-1 / 16 kernel)
    sm = np.zeros_like(hist)
    for b in range(_ORI_BINS):
        sm[b] = (6.0 * hist[b]
                 + 4.0 * (hist[(b - 1) % _ORI_BINS] + hist[(b + 1) % _ORI_BINS])
                 + (hist[(b - 2) % _ORI_BINS] + hist[(b + 2) % _ORI_BINS])) / 16.0
    peak = sm.max()
    if peak <= 0.0:
        return [0.0]
    out = []
    for b in range(_ORI_BINS):
        left = sm[(b - 1) % _ORI_BINS]
        right = sm[(b + 1) % _ORI_BINS]
        if sm[b] > left and sm[b] > right and sm[b] >= _ORI_PEAK_RATIO * peak:
            # parabolic interpolation of the bin location
            denom = left - 2.0 * sm[b] + right
            interp = b if abs(denom) < 1e-12 else b + 0.5 * (left - right) / denom
            angle = (360.0 - interp * (360.0 / _ORI_BINS)) % 360.0
            out.append(np.deg2rad(angle))
    return out or [0.0]


def detect(image, max_features: int = 4096, *, n_scales: int = _N_SCALES,
           contrast_threshold: float = _CONTRAST_THRESHOLD, edge_threshold: float = _EDGE_THRESHOLD,
           double_image: bool = True) -> Keypoints:
    """Detect scale-space DoG keypoints on an image (SPEC-13 §5.4-1, plan P1.2).

    Accepts an RGB ``(H, W, 3)`` or grayscale ``(H, W)`` uint8/float image. Returns a
    :class:`Keypoints` sorted by descending ``response`` and capped at ``max_features``. Deterministic
    (no RNG, fixed traversal / tie-break order).

    The tuning knobs default to OpenCV SIFT's own values (``n_scales=3``, ``contrast_threshold=0.04``,
    ``edge_threshold=10``, doubled base) — the sane regime for real megapixel photos, where a lower
    contrast floor would flood matching/BA with weak features. Tiny, softly (value-noise) textured
    oracle fixtures are genuinely sparse (OpenCV's own ``SIFT_create()`` finds only ~34 keypoints on a
    96 px synthetic view), so tests that need a denser set pass a lower ``contrast_threshold`` / higher
    ``n_scales`` explicitly rather than baking a permissive floor into production.
    """
    ss = build_scale_space(image, n_scales=n_scales, double_image=double_image)
    prelim = 0.5 * contrast_threshold / ss.n_scales  # OpenCV preliminary DoG magnitude gate

    xy_list: list = []
    scale_list: list = []
    ori_list: list = []
    resp_list: list = []

    # gradient-map cache: (octave, layer) → (mag, ori) numpy maps, computed lazily in MLX
    grad_cache: dict = {}

    for o in range(ss.n_octaves):
        dog_mx = ss.dog[o]
        dog_np = np.array(dog_mx, dtype=np.float32).astype(np.float64)
        n_dog = dog_np.shape[0]
        octave_pix = ss.octave_scale(o)
        for layer in range(1, n_dog - 1):  # searchable centres 1..S
            mask = _extrema_mask(dog_mx[layer - 1], dog_mx[layer], dog_mx[layer + 1], prelim)
            coords = np.argwhere(mask)  # (M, 2) (row, col), row-major deterministic order
            for row, col in coords:
                row = int(row)
                col = int(col)
                if (row < _IMG_BORDER or row >= dog_np.shape[1] - _IMG_BORDER
                        or col < _IMG_BORDER or col >= dog_np.shape[2] - _IMG_BORDER):
                    continue
                res = _localize(dog_np, layer, row, col, ss.n_scales,
                                contrast_threshold, edge_threshold)
                if res is None:
                    continue
                layer_f, row_f, col_f, response = res
                layer_r = int(round(layer_f))
                layer_r = min(max(layer_r, 0), ss.gaussian[o].shape[0] - 1)
                if (o, layer_r) not in grad_cache:
                    grad_cache[(o, layer_r)] = gradient_maps(ss.gaussian[o][layer_r])
                mag, ori = grad_cache[(o, layer_r)]
                scl_octv = ss.sigma * (2.0 ** (layer_f / ss.n_scales))
                angles = _orientations(mag, ori, int(round(row_f)), int(round(col_f)), scl_octv)
                abs_scale = scl_octv * octave_pix
                x_orig = col_f * octave_pix
                y_orig = row_f * octave_pix
                for angle in angles:
                    xy_list.append((x_orig, y_orig))
                    scale_list.append(abs_scale)
                    ori_list.append(angle)
                    resp_list.append(response)

    if not xy_list:
        return Keypoints(xy=np.zeros((0, 2)), scale=np.zeros(0),
                         orientation=np.zeros(0), response=np.zeros(0))

    xy = np.array(xy_list, dtype=np.float64)
    scale = np.array(scale_list, dtype=np.float64)
    orientation = np.array(ori_list, dtype=np.float64)
    response = np.array(resp_list, dtype=np.float64)

    # deterministic order: response desc, then y, x, scale, orientation asc as tie-breakers
    order = np.lexsort((orientation, scale, xy[:, 0], xy[:, 1], -response))
    xy = xy[order]
    scale = scale[order]
    orientation = orientation[order]
    response = response[order]

    if xy.shape[0] > max_features:
        xy = xy[:max_features]
        scale = scale[:max_features]
        orientation = orientation[:max_features]
        response = response[:max_features]

    return Keypoints(xy=xy, scale=scale, orientation=orientation, response=response)


# --- SIFT descriptor (appended P1.3) -----------------------------------------------------------
#
# The 128-d Lowe SIFT descriptor with root-SIFT normalization (SPEC-13 §5.4-1). A 4×4 grid of 8-bin
# gradient-orientation histograms, sampled in the keypoint's scale + orientation-normalized frame with
# trilinear interpolation into ``(bin_row, bin_col, bin_ori)``, then L2-normalized → clipped to 0.2 →
# L2-renormalized, then root-SIFT (L1-normalize + element-wise sqrt). Reuses the P1.2 scale space:
# each keypoint is described from the Gaussian layer nearest its scale, reusing ``build_scale_space``
# and ``gradient_maps``.
#
# Numerics (D-9/D-10): the *heavy sampling* — gathering the window's gradient magnitude/orientation
# from the layer and its Gaussian window weighting — runs batched in ``mlx.core`` float32 with
# ``take`` (gather) + elementwise ops only (no scatter, which is non-deterministic on the GPU); the
# per-keypoint trilinear histogram accumulation is a deterministic ``numpy.add.at`` scatter in float64.
# There is no RNG and the traversal order is fixed, so two runs return identical descriptors.
#
# Algorithm reimplemented (no code copied) with attribution: Lowe, *Distinctive Image Features from
# Scale-Invariant Keypoints*, IJCV 2004 §6 (the descriptor); Arandjelović & Zisserman, *Three things
# everyone should know to improve object retrieval*, CVPR 2012 (root-SIFT — L1 + sqrt so the L2 inner
# product approximates the Hellinger kernel); the weight-free kornia reference
# ``kornia/feature/siftdesc.py`` (Apache-2.0), which follows Lowe and OpenCV's ``calcSIFTDescriptor``.


def _octave_and_layer(scale_abs: float, ss: ScaleSpace):
    """Map an absolute Gaussian σ to the ``(octave, layer)`` whose blur is nearest it, plus the
    octave's pixel scale and the octave-local σ (SPEC-13 §5.4-1 "layer nearest the keypoint's scale").

    ``octave + first_octave = floor(log2(σ / sigma))`` puts the octave-local σ in ``[sigma, 2·sigma)``;
    the layer is ``round(n_scales · log2(σ_octave / sigma))``. Both are clamped to the built pyramid.
    """
    n_layers = ss.gaussian[0].shape[0]  # n_scales + 3
    oo = int(np.floor(np.log2(max(scale_abs / ss.sigma, 1e-8))))
    octave = min(max(oo - ss.first_octave, 0), ss.n_octaves - 1)
    octave_pix = ss.octave_scale(octave)
    scl_octv = scale_abs / octave_pix
    layer = int(round(ss.n_scales * np.log2(max(scl_octv / ss.sigma, 1e-8))))
    layer = min(max(layer, 0), n_layers - 1)
    return octave, layer, octave_pix, scl_octv


def _kp_window_samples(col: float, row: float, scl_octv: float, theta: float, h: int, w: int):
    """The valid gradient-window samples for one keypoint, in octave-local coordinates.

    Returns ``(flat_idx, c_rot, r_rot, rbin, cbin)`` numpy arrays for the in-bounds samples of the
    rotated ``round(hist_width·√2·(d+1)·½)`` window: ``flat_idx`` is the row-major pixel index into the
    ``(h, w)`` layer (for the MLX gather); ``c_rot/r_rot`` are the rotated offsets in subregion units
    (for the Gaussian window weight); ``rbin/cbin`` are the trilinear grid coordinates. Mirrors
    OpenCV's ``calcSIFTDescriptor`` sample loop; ``cos_t/sin_t`` carry the ``1/hist_width`` factor.
    """
    ptx, pty = int(round(col)), int(round(row))
    hist_width = _DESCR_SCL_FCTR * scl_octv
    radius = int(round(hist_width * _SQRT2 * (_DESCR_WIDTH + 1) * 0.5))
    radius = min(radius, int(np.sqrt(float(h) * h + float(w) * w)))
    cos_t = np.cos(theta) / hist_width
    sin_t = np.sin(theta) / hist_width
    span = np.arange(-radius, radius + 1, dtype=np.float64)
    ii, jj = np.meshgrid(span, span, indexing="ij")  # row (i) / column (j) offsets
    ii = ii.ravel()
    jj = jj.ravel()
    rr = pty + ii
    cc = ptx + jj
    c_rot = jj * cos_t - ii * sin_t
    r_rot = jj * sin_t + ii * cos_t
    rbin = r_rot + _DESCR_WIDTH / 2.0 - 0.5
    cbin = c_rot + _DESCR_WIDTH / 2.0 - 0.5
    sel = ((rbin > -1.0) & (rbin < _DESCR_WIDTH) & (cbin > -1.0) & (cbin < _DESCR_WIDTH)
           & (rr > 0) & (rr < h - 1) & (cc > 0) & (cc < w - 1))
    rr_i = rr[sel].astype(np.int64)
    cc_i = cc[sel].astype(np.int64)
    return rr_i * w + cc_i, c_rot[sel], r_rot[sel], rbin[sel], cbin[sel]


def _trilinear_hist(k_group: int, kp_id: np.ndarray, rbin: np.ndarray, cbin: np.ndarray,
                    obin: np.ndarray, mag: np.ndarray) -> np.ndarray:
    """Deterministic trilinear scatter-add of weighted samples into ``(k_group, d, d, n)`` histograms.

    Each sample splits its magnitude across the eight neighbouring ``(row, col, ori)`` bins; row/col
    contributions falling outside ``[0, d)`` are dropped (OpenCV discards the padded border rows), and
    the orientation bin wraps mod ``n``. ``numpy.add.at`` makes the accumulation order-independent.
    """
    hist = np.zeros((k_group, _DESCR_WIDTH, _DESCR_WIDTH, _DESCR_HIST_BINS), dtype=np.float64)
    r0 = np.floor(rbin).astype(np.int64)
    c0 = np.floor(cbin).astype(np.int64)
    o0 = np.floor(obin).astype(np.int64)
    dr = rbin - r0
    dc = cbin - c0
    do = obin - o0
    o0 = np.mod(o0, _DESCR_HIST_BINS)
    for roff, wr in ((0, 1.0 - dr), (1, dr)):
        ri = r0 + roff
        r_ok = (ri >= 0) & (ri < _DESCR_WIDTH)
        for coff, wc in ((0, 1.0 - dc), (1, dc)):
            ci = c0 + coff
            rc_ok = r_ok & (ci >= 0) & (ci < _DESCR_WIDTH)
            for ooff, wo in ((0, 1.0 - do), (1, do)):
                oi = np.mod(o0 + ooff, _DESCR_HIST_BINS)
                weight = mag * wr * wc * wo
                if np.any(rc_ok):
                    np.add.at(hist, (kp_id[rc_ok], ri[rc_ok], ci[rc_ok], oi[rc_ok]), weight[rc_ok])
    return hist


def _finalize_descriptors(hist: np.ndarray) -> np.ndarray:
    """Normalize ``(K, d, d, n)`` histograms to root-SIFT ``(K, 128)`` float32.

    Row-major flatten to ``(i·d + j)·n + k`` (OpenCV's descriptor layout), then per row: L2-normalize
    → clip to ``_DESCR_MAG_THR`` → L2-renormalize → root-SIFT (L1-normalize + element-wise sqrt). A
    root-SIFT vector is non-negative and, for any non-degenerate keypoint, unit L2 norm.
    """
    vec = hist.reshape(hist.shape[0], -1)  # (K, 128), C-order == (i*d + j)*n + k
    l2 = np.linalg.norm(vec, axis=1, keepdims=True)
    vec = np.divide(vec, l2, out=np.zeros_like(vec), where=l2 > 1e-12)
    vec = np.minimum(vec, _DESCR_MAG_THR)
    l2 = np.linalg.norm(vec, axis=1, keepdims=True)
    vec = np.divide(vec, l2, out=np.zeros_like(vec), where=l2 > 1e-12)
    l1 = np.abs(vec).sum(axis=1, keepdims=True)
    vec = np.sqrt(np.divide(vec, l1, out=np.zeros_like(vec), where=l1 > 1e-12))
    return vec.astype(np.float32)


def compute_descriptors(image, keypoints: Keypoints, *, n_scales: int = _N_SCALES,
                        sigma: float = _SIGMA, double_image: bool = True) -> np.ndarray:
    """The 128-d root-SIFT descriptors for ``keypoints`` on ``image`` (SPEC-13 §5.4-1, plan P1.3).

    Returns an ``(K, 128)`` float32 array row-aligned to ``keypoints`` (row ``i`` describes keypoint
    ``i``). Rebuilds the P1.2 scale space (``sigma``/``n_scales``/``double_image`` must match the
    ``detect`` call that produced ``keypoints``), then describes each keypoint from the Gaussian layer
    nearest its scale, in its orientation-normalized frame. Deterministic (no RNG, fixed order).

    Heavy window sampling runs batched per Gaussian layer in MLX float32 (``take`` gather + elementwise
    weighting, no scatter); the trilinear histogram accumulation is a deterministic numpy scatter-add.
    """
    k = int(keypoints.xy.shape[0])
    desc = np.zeros((k, 128), dtype=np.float32)
    if k == 0:
        return desc

    ss = build_scale_space(image, sigma=sigma, n_scales=n_scales, double_image=double_image)

    # bucket keypoints by the (octave, layer) they are described from; keep per-keypoint frame params
    groups: dict = {}
    frame: list = [None] * k
    for idx in range(k):
        octave, layer, octave_pix, scl_octv = _octave_and_layer(float(keypoints.scale[idx]), ss)
        col = float(keypoints.xy[idx, 0]) / octave_pix
        row = float(keypoints.xy[idx, 1]) / octave_pix
        # The descriptor frame is rotated by the *dominant gradient direction* φ_dom, which is
        # ``360° − angle``: ``Keypoints.orientation`` stores Lowe/OpenCV's ``kpt.angle = 360° − φ_dom``
        # (see ``_orientations``), and OpenCV's ``calcDescriptors`` passes ``360° − kpt.angle`` (= φ_dom)
        # to the descriptor. So the descriptor angle is the negation of the stored orientation.
        theta = -float(keypoints.orientation[idx])
        groups.setdefault((octave, layer), []).append(idx)
        frame[idx] = (col, row, scl_octv, theta)

    grad_cache: dict = {}
    for (octave, layer), idxs in groups.items():
        if (octave, layer) not in grad_cache:
            mag_np, ori_np = gradient_maps(ss.gaussian[octave][layer])
            grad_cache[(octave, layer)] = (mx.array(mag_np.reshape(-1)),
                                           mx.array(ori_np.reshape(-1)), mag_np.shape)
        mag_flat_mx, ori_flat_mx, (h, w) = grad_cache[(octave, layer)]

        flat_parts, crot_parts, rrot_parts, rbin_parts, cbin_parts, id_parts, thetadeg_parts = (
            [], [], [], [], [], [], [])
        for local_id, idx in enumerate(idxs):
            col, row, scl_octv, theta = frame[idx]
            flat, c_rot, r_rot, rbin, cbin = _kp_window_samples(col, row, scl_octv, theta, h, w)
            if flat.size == 0:
                continue
            flat_parts.append(flat)
            crot_parts.append(c_rot)
            rrot_parts.append(r_rot)
            rbin_parts.append(rbin)
            cbin_parts.append(cbin)
            id_parts.append(np.full(flat.size, local_id, dtype=np.int64))
            thetadeg_parts.append(np.full(flat.size, np.rad2deg(theta), dtype=np.float64))
        if not flat_parts:
            continue

        flat_all = np.concatenate(flat_parts)
        crot_all = np.concatenate(crot_parts)
        rrot_all = np.concatenate(rrot_parts)
        rbin_all = np.concatenate(rbin_parts)
        cbin_all = np.concatenate(cbin_parts)
        id_all = np.concatenate(id_parts)
        thetadeg_all = np.concatenate(thetadeg_parts)

        # --- MLX float32 gather + Gaussian window weighting (heavy, batched, no scatter) ---
        idx_mx = mx.array(flat_all.astype(np.int32))
        mags = mx.take(mag_flat_mx, idx_mx)
        oris = mx.take(ori_flat_mx, idx_mx)
        wsq = mx.array((crot_all * crot_all + rrot_all * rrot_all).astype(np.float32))
        mag_w = mags * mx.exp(wsq * _DESCR_EXP_SCALE)
        mx.eval(mag_w, oris)
        mag_w_np = np.asarray(mag_w, dtype=np.float32).astype(np.float64)
        ori_deg = np.asarray(oris, dtype=np.float32).astype(np.float64) * (180.0 / np.pi)

        # orientation bin relative to the keypoint orientation (mod n handles the [0,360) wrap)
        obin = (ori_deg - thetadeg_all) * _DESCR_BINS_PER_DEG
        hist = _trilinear_hist(len(idxs), id_all, rbin_all, cbin_all, obin, mag_w_np)
        desc[idxs] = _finalize_descriptors(hist)

    return desc


def detect_and_describe(image, max_features: int = 4096, *, n_scales: int = _N_SCALES,
                        contrast_threshold: float = _CONTRAST_THRESHOLD,
                        edge_threshold: float = _EDGE_THRESHOLD,
                        double_image: bool = True) -> tuple[Keypoints, np.ndarray]:
    """Detect keypoints and compute their root-SIFT descriptors in one call (plan P1.3).

    Returns ``(keypoints, descriptors)`` with ``descriptors`` an ``(K, 128)`` float32 array row-aligned
    to ``keypoints``. A convenience over ``detect`` + ``compute_descriptors`` with matched scale-space
    parameters; deterministic.
    """
    keypoints = detect(image, max_features, n_scales=n_scales,
                       contrast_threshold=contrast_threshold, edge_threshold=edge_threshold,
                       double_image=double_image)
    descriptors = compute_descriptors(image, keypoints, n_scales=n_scales, double_image=double_image)
    return keypoints, descriptors
