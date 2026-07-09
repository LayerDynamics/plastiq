"""Plastiq mesh→B-rep reconstruction service.

Turns a generated/imported triangle mesh (the creative path's output) into a real
OpenCASCADE B-rep shape and exports it as STEP, so a mesh document can become editable
CAD geometry. Runs server-side because OCCT surface fitting (deterministic primitive
detection + closed-form least-squares fits — no RANSAC, per NFR-2 — R6.3+) is not
feasible in the browser's OCCT-WASM build.
"""
