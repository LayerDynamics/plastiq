// Phase 3 freeform control-net editor. Selecting a freeform feature reveals its
// pole lattice in the viewport. Pole motion updates a pure-TS tessellated preview
// during the drag; only mouse-up commits the document and schedules an OCCT
// rebuild, so interaction never waits on the worker.

import { useEffect, useMemo, useRef, useState } from "react";
import { Html, Line, TransformControls } from "@react-three/drei";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { tessellateFreeform, type NurbsSurface } from "@plastiq/cad";
import { useCadStore } from "../../store/store.js";
import {
  editableSurfaceFromFeature,
  featureDataAfterControlDrag,
} from "../../freeform/controlNetEdit.js";
import { useGizmoPresence } from "./presence.js";

type Pole = { i: number; j: number };
type FreeformViewportSeam = {
  freeformControlPointPx?: (i: number, j: number) => { x: number; y: number } | null;
};

function previewGeometry(surface: NurbsSurface, resU: number, resV: number): THREE.BufferGeometry {
  const mesh = tessellateFreeform(surface, { resU, resV });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return geometry;
}

export function FreeformControlNetGizmo(): React.JSX.Element | null {
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const feature = useCadStore((s) =>
    s.features.find((candidate) => candidate.id === s.selectedFeatureId),
  );
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const source = useMemo(() => (feature ? editableSurfaceFromFeature(feature) : null), [feature]);
  const [live, setLive] = useState<NurbsSurface | null>(source);
  const [selected, setSelected] = useState<Pole | null>(null);
  const handle = useRef<THREE.Mesh>(null);
  const liveRef = useRef<NurbsSurface | null>(source);
  const dragBase = useRef<NurbsSurface | null>(null);
  const dragging = useRef(false);
  const scrub = useRef<{
    pointerY: number;
    point: [number, number, number];
    base: NurbsSurface;
  } | null>(null);

  const active = feature?.type === "freeform" && source != null;
  useGizmoPresence("freeformControlNet", active);

  useEffect(() => {
    if (dragging.current) return;
    liveRef.current = source;
    setLive(source);
    setSelected(null);
  }, [source, selectedFeatureId]);

  const selectedPoint =
    live && selected ? (live.controlNet[selected.i]?.[selected.j] ?? null) : null;

  useEffect(() => {
    if (handle.current && selectedPoint && !dragging.current) {
      handle.current.position.set(selectedPoint[0], selectedPoint[1], selectedPoint[2]);
    }
  }, [selectedPoint]);

  const geometry = useMemo(() => {
    if (!live || !feature) return null;
    const resU = Math.max(4, Math.floor(feature.params?.["resU"] ?? 16));
    const resV = Math.max(4, Math.floor(feature.params?.["resV"] ?? 16));
    return previewGeometry(live, resU, resV);
  }, [feature, live]);
  useEffect(() => () => geometry?.dispose(), [geometry]);

  useEffect(() => {
    const viewport = ((
      globalThis as { __plastiqViewport?: FreeformViewportSeam }
    ).__plastiqViewport ??= {});
    viewport.freeformControlPointPx = (i, j) => {
      const point = liveRef.current?.controlNet[i]?.[j];
      if (!point) return null;
      const projected = new THREE.Vector3(point[0], point[1], point[2]).project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      return {
        x: rect.left + ((projected.x + 1) * rect.width) / 2,
        y: rect.top + ((1 - projected.y) * rect.height) / 2,
      };
    };
    return () => {
      const current = (globalThis as { __plastiqViewport?: FreeformViewportSeam })
        .__plastiqViewport;
      if (current) delete current.freeformControlPointPx;
    };
  }, [camera, gl]);

  if (!active || !feature || !live || !geometry) return null;

  const updateLivePole = (
    pole: Pole,
    position: [number, number, number],
    base: NurbsSurface,
  ): void => {
    const controlNet: NurbsSurface["controlNet"] = base.controlNet.map((row, i) =>
      row.map((point, j): [number, number, number] =>
        i === pole.i && j === pole.j ? [...position] : [...point],
      ),
    );
    const next: NurbsSurface = {
      ...base,
      controlNet,
      ...(base.weights ? { weights: base.weights.map((row) => row.slice()) } : {}),
    };
    liveRef.current = next;
    setLive(next);
  };

  const commitPole = (pole: Pole, base: NurbsSurface): void => {
    const surface = liveRef.current;
    const position = surface?.controlNet[pole.i]?.[pole.j];
    if (!surface || !position) return;
    const weight = surface.weights?.[pole.i]?.[pole.j];
    const data = featureDataAfterControlDrag(
      { ...(feature.data ?? {}), surface: base },
      pole.i,
      pole.j,
      position,
      weight,
    );
    useCadStore.getState().setFeatureData(feature.id, data);
    useCadStore
      .getState()
      .setStatus(`control point ${pole.i + 1},${pole.j + 1} committed — rebuilding`);
  };

  const rows = live.controlNet;
  const columns = rows[0]?.map((_, j) => rows.map((row) => row[j]!)) ?? [];

  return (
    <group name="freeform-control-net">
      <mesh geometry={geometry} renderOrder={2} raycast={() => null}>
        <meshBasicMaterial
          color="#ff9d3d"
          transparent
          opacity={0.2}
          wireframe
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {[...rows, ...columns].map((points, index) => (
        <Line
          key={`net-${index}`}
          points={points}
          color="#ffb45c"
          lineWidth={1}
          transparent
          opacity={0.8}
          depthTest={false}
        />
      ))}
      {rows.flatMap((row, i) =>
        row.map((point, j) => {
          const isSelected = selected?.i === i && selected.j === j;
          return (
            <mesh
              key={`${i}-${j}`}
              position={point}
              renderOrder={4}
              onPointerDown={(event: ThreeEvent<PointerEvent>) => {
                event.stopPropagation();
                setSelected({ i, j });
              }}
            >
              <sphereGeometry args={[isSelected ? 0.0023 : 0.0017, 14, 14]} />
              <meshBasicMaterial color={isSelected ? "#fff0bf" : "#ff8b2b"} depthTest={false} />
            </mesh>
          );
        }),
      )}
      {selected && selectedPoint && (
        <>
          <TransformControls
            mode="translate"
            onMouseDown={() => {
              dragging.current = true;
              dragBase.current = liveRef.current;
            }}
            onObjectChange={() => {
              const base = dragBase.current;
              const object = handle.current;
              if (!base || !object) return;
              updateLivePole(
                selected,
                [object.position.x, object.position.y, object.position.z],
                base,
              );
            }}
            onMouseUp={() => {
              const base = dragBase.current;
              dragging.current = false;
              dragBase.current = null;
              if (base) commitPole(selected, base);
            }}
          >
            <mesh ref={handle} position={selectedPoint} visible={false}>
              <sphereGeometry args={[0.002, 8, 8]} />
              <meshBasicMaterial />
            </mesh>
          </TransformControls>
          <Html position={selectedPoint} pointerEvents="auto" zIndexRange={[850, 0]}>
            <div
              data-testid="freeform-control-point-editor"
              className="ml-4 flex items-center gap-1 rounded border border-[#7a5328] bg-[#111722]/95 px-1.5 py-1 text-[10px] text-[#ffd7a0] shadow-lg"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span>
                Pole {selected.i + 1},{selected.j + 1}
              </span>
              <span
                data-testid="freeform-control-point-drag"
                title="Drag vertically to move this pole along Z"
                className="cursor-ns-resize select-none rounded bg-[#2b2118] px-1 text-[#ffb45c]"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragging.current = true;
                  scrub.current = {
                    pointerY: event.clientY,
                    point: [...selectedPoint],
                    base: liveRef.current!,
                  };
                }}
                onPointerMove={(event) => {
                  const start = scrub.current;
                  if (!start) return;
                  const dz = (start.pointerY - event.clientY) * 0.0001;
                  updateLivePole(
                    selected,
                    [start.point[0], start.point[1], start.point[2] + dz],
                    start.base,
                  );
                }}
                onPointerUp={(event) => {
                  const start = scrub.current;
                  scrub.current = null;
                  dragging.current = false;
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  if (start) commitPole(selected, start.base);
                }}
              >
                Z ⇅
              </span>
            </div>
          </Html>
        </>
      )}
    </group>
  );
}
