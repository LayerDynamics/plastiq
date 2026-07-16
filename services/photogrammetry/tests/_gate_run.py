"""Ad-hoc real-photo gate driver (not a pytest test) — runs the sparse pipeline on a dataset and
prints the report. Used to get real P7 numbers before finalizing tests/test_gate_real.py."""
import os
import sys
import time
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.pipeline import solve_sparse

def load(path, max_dim):
    im = Image.open(path).convert("RGB")
    s = max_dim / max(im.size)
    if s < 1.0:
        im = im.resize((round(im.size[0]*s), round(im.size[1]*s)))
    return np.asarray(im)

def main(dataset, max_dim, max_features):
    base = f"/Users/ryanoboyle/cad-studio/ref/Photogrammetry-examples/{dataset}/images"
    names = sorted(n for n in os.listdir(base) if n.lower().endswith((".jpg",".jpeg")))
    paths = [os.path.join(base, n) for n in names]
    imgs = [load(p, max_dim) for p in paths]
    t0 = time.time()
    res = solve_sparse(imgs, exif_images=paths, image_names=names, matching="exhaustive",
                       max_features=max_features, seed=0, self_calibrate=False)
    r = res.report
    print(f"[{dataset}] {r['images_registered']}/{r['images_total']} registered | "
          f"reproj={r['mean_reprojection_error_px']:.3f}px | track_len={r['mean_track_length']:.2f} | "
          f"points={r['sparse_points']} | {time.time()-t0:.0f}s", flush=True)
    print(f"  unregistered: {r['unregistered_names']}", flush=True)
    pct = r['images_registered']/r['images_total']
    gate = pct >= 0.85 and r['mean_reprojection_error_px'] <= 1.5 and r['mean_track_length'] >= 3.0
    print(f"  GATE {'PASS' if gate else 'FAIL'} (need >=85% reg, <=1.5px, track>=3)", flush=True)

if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
