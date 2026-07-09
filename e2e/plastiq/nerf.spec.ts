// SPEC-11 N11.3 — browser NeRF capture E2E (no mocks): posed photos are turned into an editable
// mesh document through the WHOLE real stack — browser → GenerationPanel NerfCaptureSection →
// @plastiq/nerf client → HTTP → the running MLX nerf service (real training + marching-cubes) →
// GLB → MeshDoc → the project opens → the mesh renders in the viewport. This mirrors the
// reconstruct.spec.ts precedent (SPEC-11 §6 "the reconstruct precedent"): a service-reachability
// probe gates the test, so CI without the service skips cleanly; when the service IS up it drives
// the real UI end to end with no mocks.
//
// Gated on the nerf service being reachable (NERF_URL, default http://localhost:8002 — the
// documented dev port / NERF_DEFAULT_BASE_URL). Run it with the service up:
//   (svc)  mamba run -n plastiq-nerf uvicorn app.main:app --port 8002   (or: just services)
//   (e2e)  pnpm e2e --grep nerf
//
// The fixtures are generated deterministically in-process: a tiny nerfstudio-style transforms.json
// (ring cameras around the origin, mirroring services/nerf/tests/synthetic.py) plus one small
// normal-shaded PNG per frame. Combined with the panel's smallest fast knobs (few iters, 32³ grid),
// the real MLX training finishes in seconds — the same regime the service's own training tests use.

import zlib from "node:zlib";
import { expect, test } from "@playwright/test";

const NERF_URL = process.env.NERF_URL ?? "http://localhost:8002";

declare global {
  // eslint-disable-next-line no-var
  var meshBodyCount: () => number;
}

async function serviceReachable(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(`${NERF_URL}/health`, { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// --- Minimal, dependency-free PNG encoder (8-bit RGB, no filter) -----------------------------------
// The nerf service ingests base64 PNG/JPEG frames; a real, decodable PNG per frame is all it needs.
// Hand-rolled so the spec stays self-contained (no image lib, no checked-in binaries).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour (RGB)
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter byte: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// A centred, normal-shaded disc — the same 0.5+0.5·n colouring the service's synthetic sphere uses,
// so the frames carry real, trainable signal (not flat colour) for the SDF/density fit.
function renderView(w: number, h: number): Buffer {
  const rgb = Buffer.alloc(w * h * 3);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const r = Math.min(w, h) * 0.4;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / r;
      const dy = (y - cy) / r;
      const d2 = dx * dx + dy * dy;
      const idx = (y * w + x) * 3;
      if (d2 <= 1) {
        const nz = Math.sqrt(1 - d2);
        rgb[idx] = Math.round((0.5 + 0.5 * dx) * 255);
        rgb[idx + 1] = Math.round((0.5 + 0.5 * dy) * 255);
        rgb[idx + 2] = Math.round((0.5 + 0.5 * nz) * 255);
      }
      // else: black background (buffer is zero-filled)
    }
  return rgb;
}

// --- Ring-camera poses, mirroring services/nerf/tests/synthetic.py (+z forward c2w) ---------------
type Vec3 = [number, number, number];
function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
/** camera→world matrix (columns right, up, forward, eye) looking from `eye` at the origin. */
function lookAt(eye: Vec3): number[][] {
  const up: Vec3 = [0, 1, 0];
  const forward = normalize([-eye[0], -eye[1], -eye[2]]);
  const right = normalize(cross(up, forward));
  const trueUp = cross(forward, right);
  return [
    [right[0], trueUp[0], forward[0], eye[0]],
    [right[1], trueUp[1], forward[1], eye[1]],
    [right[2], trueUp[2], forward[2], eye[2]],
    [0, 0, 0, 1],
  ];
}

function makeFixtures(): { transforms: string; images: Buffer[] } {
  const N = 6;
  const W = 16;
  const H = 16;
  const camRadius = 3.0;
  const camY = 0.6;
  const frames = [];
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    const eye: Vec3 = [camRadius * Math.cos(a), camY, camRadius * Math.sin(a)];
    frames.push({ file_path: `view_${i}.png`, transform_matrix: lookAt(eye) });
  }
  const transforms = { w: W, h: H, fl_x: W, fl_y: H, cx: W / 2, cy: H / 2, frames };
  const rgb = renderView(W, H); // rotationally symmetric sphere → identical per view
  const images = Array.from({ length: N }, () => encodePng(W, H, rgb));
  return { transforms: JSON.stringify(transforms), images };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { meshBodyCount?: () => number }).meshBodyCount = () => {
      const vp = (globalThis as { __plastiqViewport?: { meshBodyCount?: number } }).__plastiqViewport;
      return vp?.meshBodyCount ?? 0;
    };
  });
});

test("capture a mesh from posed photos via the nerf service and open it as a mesh document", async ({
  page,
}) => {
  // Skip FIRST — before any fixture work — so a down service is a clean green skip, never an error.
  test.skip(!(await serviceReachable()), `nerf service not reachable at ${NERF_URL}`);

  const { transforms, images } = makeFixtures();

  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Seed AI settings so the panel is past first-run (shows the generation view + NerfCaptureSection)
  // and point the nerf client at the running service.
  await page.evaluate(
    async ({ url }) => {
      const ai = (globalThis as { __aiStore?: { getState: () => { save: (s: unknown) => Promise<void> } } })
        .__aiStore!;
      await ai.getState().save({
        providerKey: "ollama",
        providerId: "openai-compatible",
        model: "qwen2.5",
        apiKeys: {},
        nerfBaseURL: url,
      });
    },
    { url: NERF_URL },
  );

  // Supply the transforms.json + one PNG per frame through the real file inputs.
  await page.getByTestId("nerf-transforms-input").setInputFiles({
    name: "transforms.json",
    mimeType: "application/json",
    buffer: Buffer.from(transforms),
  });
  await page.getByTestId("nerf-images-input").setInputFiles(
    images.map((buffer, i) => ({ name: `view_${i}.png`, mimeType: "image/png", buffer })),
  );

  // Drive the §5 training knobs to the smallest fast regime so the real MLX train finishes quickly.
  await page.getByTestId("nerf-iters").fill("40");
  await page.getByTestId("nerf-grid-res").selectOption("32");

  await expect(page.getByTestId("nerf-capture")).toBeVisible();
  await expect(page.getByTestId("nerf-transforms-name")).toHaveText("transforms.json");
  await expect(page.getByTestId("nerf-capture-btn")).toBeEnabled();

  // Submit → real service trains + marching-cubes a GLB → persisted as a MeshDoc → project opened.
  await page.getByTestId("nerf-capture-btn").click();

  // The opened MeshDoc renders its bodies in the viewport (Scene publishes meshBodyCount). Wait for
  // the render (a later tick than the doc switch), then assert the panel switched to Convert-to-CAD.
  await page.waitForFunction(() => meshBodyCount() > 0, undefined, { timeout: 240_000 });
  await expect(page.getByTestId("mesh-convert")).toBeVisible();
  expect(await page.evaluate(() => meshBodyCount())).toBeGreaterThan(0);
});
