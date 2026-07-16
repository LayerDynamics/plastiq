# OpenCascade Fusion-Style Sketch System Spec

This document rewrites the sketch system as an OpenCascade implementation target that is behaviorally aligned with Fusion 360’s sketch workflow, but realized using OCCT-style data structures, OCAF history, and a separate 2D constraint solver. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)

## 1. Scope

This specification defines how to implement a Fusion-like sketch subsystem on top of OpenCascade Technology. The target is identical user-facing behavior in terms of sketch creation, constraints, dimensions, profiles, parametric regeneration, and fully constrained editing, while using OCCT’s document framework and geometry kernel as the foundation. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)
This spec does not assume Autodesk internals. It maps the observable Fusion sketch model onto an OCCT architecture that can be built with OCAF, TopoDS geometry, and an external or custom 2D constraint solver. [cnblogs](https://www.cnblogs.com/opencascade/p/planegcs.html)

## 2. Design Principles

The implementation SHALL treat a sketch as parametric design data, not as mere drawing primitives. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
The implementation SHALL separate sketch intent from resulting BRep geometry, so sketch edits regenerate dependent bodies through a deterministic update pipeline. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)
The implementation SHOULD minimize unnecessary motion during constraint solving, because parametric stability is critical for CAD usability. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)
The implementation SHOULD preserve a Fusion-like workflow of underconstrained, fully constrained, and overconstrained states. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?guid=SKT-FULLY-DEFINE-CONSTRAIN-SKETCH)

## 3. OCCT Subsystem Mapping

### 3.1 Document layer

The sketch subsystem SHALL be stored in OCAF as document data rather than as ephemeral scene state. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
Each design component SHALL correspond to a structured OCAF subtree containing sketches, construction geometry, parameters, feature history, and generated shapes. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)
Sketch feature recomputation SHALL use the OCAF function mechanism or an equivalent dependency engine so that changes to sketch inputs propagate to dependent results. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

### 3.2 Geometry layer

2D sketch geometry SHALL be stored as OCCT geometry primitives or lightweight parametric records that can be converted into TopoDS wire/edge representations for downstream use. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)
Construction planes SHALL be represented with gp_Ax3, gp_Pln, and related placement objects, with the sketch plane defining local sketch coordinates. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
Closed profiles SHALL ultimately be converted to wires and faces using OCCT topology builders and face construction tools. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)

### 3.3 Constraint solver layer

The sketch solver SHALL be an explicit geometric constraint solver. OCCT itself does not provide a full Fusion-equivalent sketch solver as a core sketching subsystem, so the implementation SHALL integrate a dedicated 2D solver such as a PlaneGCS-style solver, an LGS-style solver, or an equivalent custom solver. [dev.opencascade](https://dev.opencascade.org/content/constraints-solver-sketch-geometry-occt)
The solver MUST support 2D constraints, dimensions, and expressions, and MUST be able to resolve a sketch while minimizing motion from the initial configuration. [cnblogs](https://www.cnblogs.com/opencascade/p/planegcs.html)
The solver output SHALL update the sketch entity parameter set, which then drives the OCCT geometry regeneration step. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)

## 4. Data Model

### 4.1 Sketch container

A Sketch SHALL contain:

- A stable OCAF label or feature node.
- A plane definition.
- A local coordinate frame.
- A set of sketch entities.
- A set of constraints.
- A set of dimensions or named parameters.
- A set of derived profiles.
- A constrained-state flag.
- A dirty/recompute flag. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

### 4.2 Entity model

Each entity SHALL be stored as a parametric record with:

- Entity ID.
- Type tag.
- Geometric parameters.
- References to parent entities or construction references.
- Construction flag.
- Visibility flag.

Supported entity types SHOULD include line, polyline segment, arc, circle, ellipse, spline, point, text anchor, centerline, construction line, and projected/reference entity types. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?contextId=SKT-CONSTRAINTS)

### 4.3 Constraint model

Each constraint SHALL be stored as:

- Constraint ID.
- Constraint type.
- A list of target entities.
- Optional anchor points or evaluation points.
- Optional numeric value or expression reference.
- Solver metadata.

Constraint types SHALL include the common Fusion-equivalent set: coincidence, horizontal, vertical, parallel, perpendicular, tangent, equal, midpoint, concentric, collinear, symmetry, fixed, radius, diameter, distance, and angle. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?contextId=SKT-CONSTRAINTS)

### 4.4 Parameter model

Dimensions SHALL be implemented as named parameters in the OCAF document and MAY be referenced by constraints through symbolic names or direct object links. [github](https://github.com/xibyte/jsketcher/blob/main/README.md)
Expressions SHALL be supported so that one parameter can depend on another, matching Fusion-style parametric relationships. [youtube](https://www.youtube.com/watch?v=lsYBI-mUtgA)
Parameter changes SHALL trigger sketch solve and OCAF recomputation. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)

## 5. Coordinate and Plane Semantics

The sketch SHALL live in a local 2D coordinate system embedded in 3D space. The sketch plane SHALL provide an origin, X axis, Y axis, and normal, with 3D coordinates mapped into 2D sketch coordinates for solving. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
All planar sketch constraints SHALL be solved in sketch-local coordinates, not in global 3D coordinates, to keep the solver stable and to mirror Fusion-style planar behavior. [cnblogs](https://www.cnblogs.com/opencascade/p/planegcs.html)
Projected geometry SHALL remain linked to source geometry through references where appropriate, so that dependent sketch entities can update after upstream edits. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

## 6. State Machine

### 6.1 States

The implementation SHALL support the following states:

- Created.
- Editing.
- Underconstrained.
- Fully constrained.
- Overconstrained.
- Profile-valid.
- Profile-invalid.
- Recompute-pending.
- Recomputed. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?guid=SKT-FULLY-DEFINE-CONSTRAIN-SKETCH)

### 6.2 Transitions

- CreateSketch SHALL create the OCAF subtree, initialize parameters, and enter Editing. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)
- AddEntity SHALL update the entity collection and enter Recompute-pending. [cnblogs](https://www.cnblogs.com/opencascade/p/planegcs.html)
- AddConstraint SHALL update the constraint graph and enter Recompute-pending. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)
- SolveSuccess SHALL transition to Underconstrained or Fully constrained depending on remaining degrees of freedom. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?guid=SKT-FULLY-DEFINE-CONSTRAIN-SKETCH)
- SolveConflict SHALL transition to Overconstrained. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?guid=SKT-FULLY-DEFINE-CONSTRAIN-SKETCH)
- ProfileExtractionSuccess SHALL transition to Profile-valid. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
- FinishEdit SHALL persist the feature and return control to the 3D modeling context. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

## 7. Solver Invariants

The sketch system SHALL maintain the following invariants:

- Every active constraint SHALL be satisfiable in the current resolved state. [cnblogs](https://www.cnblogs.com/opencascade/p/planegcs.html)
- A fully constrained sketch SHALL have no unresolved translational, rotational, or scale freedom except where explicitly permitted by the sketch model. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?guid=SKT-FULLY-DEFINE-CONSTRAIN-SKETCH)
- Driving dimensions SHALL deterministically control the solved geometry. [youtube](https://www.youtube.com/watch?v=lsYBI-mUtgA)
- Driven dimensions SHALL never feed back as control inputs. [youtube](https://www.youtube.com/watch?v=lsYBI-mUtgA)
- The solver SHOULD preserve the original configuration as much as possible while satisfying constraints. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)
- Constraint resolution SHALL occur in the sketch plane’s 2D coordinate space. [cnblogs](https://www.cnblogs.com/opencascade/p/planegcs.html)
- Profile generation SHALL use the resolved geometry, not stale pre-solve coordinates. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)

## 8. Geometric Solve Logic

### 8.1 Constraint graph

The implementation SHALL build a graph whose nodes are entity degrees of freedom and whose edges are constraints and dimensions. The graph MAY be sparse, but it MUST preserve enough structure to detect cycles, rank deficiency, and redundancy. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)
The solver SHOULD compute a solve order or linearization strategy appropriate to the chosen backend solver. [cnblogs](https://www.cnblogs.com/opencascade/p/planegcs.html)
If symbolic parameters are present, the system SHOULD evaluate them before numerical solve or during a staged solve pipeline. [github](https://github.com/xibyte/jsketcher/blob/main/README.md)

### 8.2 Solve strategy

For each sketch edit:

1. Collect dirty entities and constraints.
2. Convert geometry into solver variables.
3. Apply dimension values and expressions.
4. Solve the constraint system.
5. Write back solved parameters.
6. Regenerate sketch geometry.
7. Recompute profiles and dependent features. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)

The solver SHOULD minimize motion from the previous state, because CAD sketching is expected to be stable under incremental edits. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)
If multiple valid solutions exist, the system SHOULD choose the one closest to the previous solution unless the user explicitly constrains otherwise. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)

## 9. OCCT Rebuild Pipeline

### 9.1 From solver to geometry

After solve, the implementation SHALL rebuild sketch primitives as OCCT geometry entities or topological edges.  
If the sketch contains lines and arcs, the system SHOULD build corresponding edges and wires through standard OCCT builders.  
If the sketch contains splines, the system SHALL preserve spline parameters and rebuild the curve with updated poles, knots, or weights as needed. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)

### 9.2 Profile extraction

Closed loops SHALL be detected by topological connectivity and orientation checks.  
Profile candidates SHALL be converted into wires, validated, and then optionally turned into planar faces. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
Open chains SHALL not be exposed as profiles.  
Self-intersecting or invalid loops SHALL be rejected or flagged as invalid profiles.

### 9.3 Feature consumption

Downstream features such as extrude, revolve, cut, loft, and sweep SHALL consume profile outputs or path outputs from the sketch feature. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
Feature recomputation SHALL be part of the OCAF dependency chain, so changes to sketch parameters propagate forward. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

## 10. Error Conditions

### 10.1 Overconstraint

If a new constraint makes the system unsatisfiable, the solver SHALL report overconstraint and preserve the last valid state where possible. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?guid=SKT-FULLY-DEFINE-CONSTRAIN-SKETCH)
The UI MAY highlight the conflicting constraint, but the data model SHALL remain coherent. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?guid=SKT-FULLY-DEFINE-CONSTRAIN-SKETCH)

### 10.2 Underconstraint

If degrees of freedom remain, the sketch SHALL remain valid but not fully constrained. [cnblogs](https://www.cnblogs.com/opencascade/p/planegcs.html)
The system SHOULD expose that the geometry is still free to move.  
The solver MAY still produce a valid solution, but design intent is incomplete.

### 10.3 Invalid entity references

If a constraint references a deleted or missing entity, the constraint SHALL be marked broken and excluded from the active solve set until repaired.  
The implementation SHOULD preserve the orphaned constraint record for user recovery.

### 10.4 Invalid profile

If loop closure fails, orientation is inconsistent, or self-intersection exists, the profile SHALL be marked invalid and hidden from downstream feature selection.  
Dependent features SHALL be recomputed or suppressed according to OCAF dependency behavior. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

### 10.5 Plane mismatch

If a planar sketch constraint is applied to geometry outside the sketch plane without a projection/reference rule, the operation SHALL be rejected or converted to a supported projected reference. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)

## 11. Feature History Integration

The system SHALL implement sketch features as history nodes in the OCAF tree. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)
Each sketch edit SHALL update the feature state and mark dependent nodes dirty.  
The OCAF function mechanism or equivalent SHALL be used to model dependencies between sketches, dimensions, and resulting solids. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)
This is the mechanism that makes the system behave like a timeline-based parametric model rather than a static BRep editor. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

## 12. API Requirements

A practical API for this implementation SHOULD expose:

- CreateSketch(plane).
- AddEntity(type, params).
- AddConstraint(type, targets, value).
- SetParameter(name, value).
- Solve().
- RebuildGeometry().
- ExtractProfiles().
- CommitFeature().
- QueryConstrainedState().
- GetDependencies().

The API SHOULD be suitable for integration into a CAD application that already uses OCCT for solids and assemblies. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
The API SHOULD avoid leaking solver internals into the UI layer except for diagnostics and debugging.

## 13. Persistence Requirements

All sketches, constraints, dimensions, and parameters SHALL persist in the OCAF document. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)
The document SHOULD be serializable and reloadable without loss of parametric dependency information. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
Geometry caches MAY be persisted, but the authoritative source of truth SHALL remain the sketch parameter and constraint model.

## 14. Compatibility Targets

To behave like Fusion 360, the OCCT implementation SHOULD reproduce these user-visible behaviors:

- Sketches are created on planes or faces.
- Geometry is edited through constraints and dimensions.
- Blue-like underconstrained and black-like fully constrained states exist.
- Closed profiles are automatically recognized.
- Downstream solid features update when the sketch changes.
- 3D sketching is available as an advanced mode. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?contextId=SKT-3D-SKETCH)

The system MUST accept that Fusion-like behavior is not identical to Fusion internals; the requirement is behavioral equivalence, not source-level equivalence.

## 15. Recommended Backend Choice

For an actual OpenCascade implementation, the best architecture is:

- OCAF for document/history/storage.
- OCCT geometry/topology for curves, wires, faces, and downstream solids.
- A separate 2D constraint solver for sketch logic, such as PlaneGCS-like logic or a comparable solver. [dev.opencascade](https://dev.opencascade.org/content/constraints-solver-sketch-geometry-occt)
- A parameter/expression layer for symbolic dimensions and relationships. [github](https://github.com/xibyte/jsketcher/blob/main/README.md)

This split is the most direct way to match Fusion-style sketch behavior while staying aligned with OCCT’s strengths. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

## 16. Conclusion

The key idea is that OCCT should not try to make sketching “just a drawing tool.” It should implement sketches as a solved parametric subsystem with persistent history, plane-local constraint solving, and topology regeneration. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)
That is the closest practical way to implement Fusion-style sketch behavior on OpenCascade.

Absolutely — below is a software architecture and module layout for implementing a Fusion-style sketch system on top of OpenCascade, designed for a real CAD codebase rather than a conceptual overview. It follows the OCCT strengths: OCAF for persistent parametric data, TopoDS/Geom for geometry, and a dedicated constraint solver for sketch logic. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/samples__ocaf_func.html)

# OpenCascade Sketcher Architecture

## 1. System goals

The sketcher SHALL behave like a parametric CAD subsystem, not a drawing canvas. It MUST support editable sketch entities, constraints, dimensions, profile extraction, and regeneration of dependent 3D features from persistent document data. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf.html)
The implementation SHOULD mirror Fusion-like workflow semantics: create sketch on a plane, author geometry, constrain it, solve it, detect closed profiles, and feed downstream features. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
The architecture SHOULD isolate sketch solving from BRep generation so that the solver can be replaced or upgraded without rewriting the core OCCT document model. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)

## 2. High-level layers

The system SHOULD be divided into five layers:

- UI layer.
- Sketch authoring layer.
- Constraint/solver layer.
- Parametric document layer.
- BRep generation and downstream feature layer. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/samples__ocaf_func.html)

The UI layer handles tool interaction, selection, snapping, and sketch display.  
The authoring layer converts user actions into sketch entities, constraints, and parameters.  
The solver layer computes a stable 2D solution for the sketch.  
The document layer persists state and dependency history through OCAF.  
The BRep layer converts resolved sketch results into OCCT wires, faces, and feature inputs. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

## 3. Module layout

A clean OCCT-oriented package structure could be:

```text
cad/
  app/
    main/
    commands/
    ui/
    selection/
    view/
  sketch/
    model/
    entities/
    constraints/
    parameters/
    profiles/
    serialization/
    commands/
    solve/
  parametric/
    ocaf/
    functions/
    dependencies/
    expressions/
    features/
  geometry/
    plane/
    projection/
    topology/
    rebuild/
  solver/
    core/
    adapters/
    diagnostics/
    linear/
    nonlinear/
  brep/
    builders/
    wires/
    faces/
    feature_consumers/
  infra/
    events/
    logging/
    undo/
    tests/
```

This structure separates human-facing sketch authoring from solver internals and from OCCT shape construction, which is the most maintainable way to match Fusion-like behavior in OCCT. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)

## 4. Core modules

### 4.1 `sketch/model`

This module SHALL own the logical sketch object model. It contains `Sketch`, `SketchEntity`, `SketchConstraint`, `SketchDimension`, `SketchProfile`, and reference types.  
Its responsibility is to represent the authoritative in-memory model before serialization to OCAF. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf.html)
It SHOULD be solver-agnostic, so the same model can be used for preview, solve, and regeneration.

### 4.2 `sketch/entities`

This module SHALL define entity classes and their canonical parameters:

- `LineEntity`.
- `ArcEntity`.
- `CircleEntity`.
- `SplineEntity`.
- `PointEntity`.
- `ConstructionLineEntity`.
- `ReferenceEntity`.

Each entity SHOULD expose a local parameterization that can be mapped into solver variables. [cnblogs](https://www.cnblogs.com/opencascade/p/planegcs.html)
Entity objects SHOULD know how to:

- report degrees of freedom,
- export solver variables,
- rebuild geometry from solved values,
- provide hit-testing and drawing primitives.

### 4.3 `sketch/constraints`

This module SHALL represent geometric constraints as data and behavior.  
Each constraint SHOULD have:

- type,
- target handles,
- optional anchor points,
- optional numeric argument,
- diagnostic state.

Constraint classes SHOULD not solve themselves. They should compile into solver primitives or equations for the solver backend. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)
This module SHOULD also define constraint metadata for the UI, such as icons, labels, and conflict descriptions.

### 4.4 `sketch/parameters`

This module SHALL manage named dimensions, expressions, and parameter references.  
It SHOULD support user parameters, sketch-local parameters, and feature-level parameters. [youtube](https://www.youtube.com/watch?v=lsYBI-mUtgA)
Expressions SHOULD be compiled into a dependency graph so that parameter changes propagate predictably. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

### 4.5 `sketch/solve`

This module SHALL act as the solver adapter boundary.  
It SHOULD convert sketch model data into solver input, call the solver, and map results back onto sketch entities.  
It MUST also classify results into underconstrained, fully constrained, and overconstrained states. [help.autodesk](https://help.autodesk.com/view/fusion360/ENU/?guid=SKT-FULLY-DEFINE-CONSTRAIN-SKETCH)

A practical internal layout is:

```text
sketch/solve/
  adapter.cpp
  variable_map.cpp
  constraint_compiler.cpp
  result_mapper.cpp
  state_classifier.cpp
  diagnostics.cpp
```

### 4.6 `solver/core`

This module SHALL contain the actual geometric solve engine or adapters to one.  
Because OCCT does not provide a Fusion-equivalent sketch solver out of the box, this layer SHOULD integrate a dedicated solver such as PlaneGCS-style logic or a custom nonlinear solver. [dev.opencascade](https://dev.opencascade.org/content/constraints-solver-sketch-geometry-occt)
It SHOULD provide:

- variable creation,
- equation compilation,
- solve execution,
- redundant constraint detection,
- conflict reporting,
- convergence diagnostics.

### 4.7 `parametric/ocaf`

This module SHALL map sketch data into OCAF labels and attributes. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf.html)
It SHOULD use document labels to represent:

- components,
- sketches,
- entities,
- constraints,
- parameters,
- generated results.

It SHOULD also provide serialization, undo/redo integration, and dirty propagation through the OCAF dependency structure. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/samples__ocaf_func.html)

### 4.8 `parametric/functions`

This module SHALL implement OCAF function drivers for sketch recomputation and feature generation. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)
Each sketch feature MAY be represented as a function node that:

- reads sketch inputs,
- resolves the solver state,
- emits updated geometry,
- publishes generated results to dependent features.

This is the equivalent of a timeline node in Fusion-like behavior. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/samples__ocaf_func.html)

### 4.9 `geometry/plane`

This module SHALL handle plane creation, local axes, coordinate transforms, and projection between 3D world coordinates and sketch-local 2D coordinates. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)
It SHOULD provide conversion utilities:

- world to sketch plane,
- sketch plane to world,
- point projection,
- curve projection,
- hit-test mapping.

### 4.10 `geometry/rebuild`

This module SHALL rebuild OCCT geometry after the solver returns solved parameters.  
It SHOULD convert:

- lines into edges,
- closed chains into wires,
- wire loops into faces,
- construction geometry into non-topological helpers where appropriate. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)

## 5. OCAF document layout

A suggested document tree is:

```text
Document
  Component
    Parameters
    Sketches
      Sketch_1
        Plane
        Entities
        Constraints
        Dimensions
        Profiles
        Status
    Features
      Extrude_1
      Revolve_1
```

Each node SHOULD be represented by a label subtree and relevant attributes.  
The sketch label subtree SHOULD store enough information to fully reconstruct the sketch from the document alone. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

## 6. Class responsibilities

### 6.1 `SketchDocumentService`

Owns creation, lookup, rename, delete, and persistence of sketches.  
Bridges UI actions to OCAF model updates. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf.html)

### 6.2 `SketchEditor`

Owns the live editing session.  
Buffers user actions, maintains preview state, and triggers solve cycles on change.

### 6.3 `SketchCompiler`

Transforms entities and constraints into solver input.  
Assigns variable IDs, equation rows, and parameter dependencies.

### 6.4 `SketchSolverService`

Calls the solver backend and applies results back to the model.  
Classifies the state and generates diagnostics.

### 6.5 `ProfileExtractor`

Finds closed loops from resolved entities and produces wire/face candidates for downstream use. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)

### 6.6 `FeatureRegenerator`

Consumes sketch outputs and recomputes dependent OCCT features through OCAF dependencies. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/samples__ocaf_func.html)

## 7. Runtime flow

A single sketch edit SHOULD follow this sequence:

1. User edits entity or constraint.
2. SketchEditor records a change.
3. SketchCompiler emits solver variables and equations.
4. Solver runs.
5. Solver results map back into the sketch model.
6. Geometry rebuild runs.
7. ProfileExtractor updates profile candidates.
8. OCAF marks dependent nodes dirty.
9. FeatureRegenerator updates downstream solids. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

This flow is the core of the Fusion-like parametric experience on OCCT.

## 8. Dependency graph

The architecture SHOULD maintain three dependency graphs:

- Entity dependency graph.
- Parameter dependency graph.
- Feature dependency graph. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/samples__ocaf_func.html)

The entity graph captures geometric relations such as coincident and tangent.  
The parameter graph captures expression relationships and driven values.  
The feature graph captures sketch-to-solid and sketch-to-sketch regeneration paths.  
These graphs SHOULD be tracked in OCAF and mirrored in solver state as needed. [dev.opencascade](https://dev.opencascade.org/doc/overview/html/occt_user_guides__ocaf.html)

## 9. Event and undo model

The system SHOULD use command objects for all edit actions so undo/redo can be handled cleanly.  
Each command SHOULD produce:

- an intent mutation,
- a dirty flag,
- a solver replay trigger,
- an OCAF transaction boundary. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf.html)

Events SHOULD be emitted for:

- entity added,
- constraint added,
- parameter changed,
- solve succeeded,
- solve failed,
- profile changed,
- feature recomputed.

## 10. Error handling

The architecture SHOULD isolate errors by layer:

- UI errors: invalid selection, bad input, cancellation.
- Model errors: orphaned entity, invalid reference.
- Solver errors: overconstraint, nonconvergence, ambiguous solution.
- Geometry errors: invalid wire, self-intersection, failed face build.
- Persistence errors: missing attribute, serialization mismatch. [old.opencascade](https://old.opencascade.com/content/geometric-constraint-solvers-ledas)

Each error SHOULD be converted into a diagnostic object with severity, source, affected IDs, and suggested recovery action.

## 11. Recommended C++ package split

A practical OCCT codebase could be organized like this:

```text
src/
  sketch/
    Sketch.hxx/.cxx
    SketchEntity.hxx/.cxx
    SketchConstraint.hxx/.cxx
    SketchDimension.hxx/.cxx
    SketchProfile.hxx/.cxx
  sketch/solve/
    SketchSolver.hxx/.cxx
    SketchCompiler.hxx/.cxx
    SolverAdapter.hxx/.cxx
  parametric/
    SketchFunctionDriver.hxx/.cxx
    FeatureFunctionDriver.hxx/.cxx
  geometry/
    PlaneFrame.hxx/.cxx
    ProjectionTools.hxx/.cxx
    RebuildTools.hxx/.cxx
  ocaf/
    SketchAttribute.hxx/.cxx
    ParameterAttribute.hxx/.cxx
    ProfileAttribute.hxx/.cxx
  brep/
    WireBuilder.hxx/.cxx
    FaceBuilder.hxx/.cxx
```

This split keeps the OCCT-facing code explicit and makes testing much easier.

## 12. Extension points

The architecture SHOULD allow plugin replacement for:

- solver backend,
- expression evaluator,
- profile extraction strategy,
- snapping/hit-testing,
- constraint inference,
- import/export layers.

That makes it possible to evolve the system without breaking the core sketch model.

## 13. Recommended implementation order

1. Build OCAF storage for sketches and parameters.
2. Implement plane-local geometry and coordinate transforms.
3. Implement a minimal constraint set: coincident, horizontal, vertical, distance, radius, angle.
4. Integrate a solver backend.
5. Add profile extraction and wire building.
6. Add feature regeneration through OCAF functions.
7. Expand to advanced constraints and 3D sketching. [cnblogs](https://www.cnblogs.com/opencascade/p/planegcs.html)

That order minimizes risk because it establishes persistence and solve semantics before harder geometry regeneration work.

## 14. Summary architecture view

The essential shape of the system is:

- OCAF stores the sketch history.
- The sketch model represents entities and constraints.
- The solver computes valid geometry.
- OCCT geometry rebuilds wires, faces, and features.
- OCAF dependencies propagate edits forward. [dev.opencascade](https://dev.opencascade.org/doc/occt-6.9.1/overview/html/occt_user_guides__ocaf_functionmechanism_wp.html)

That is the cleanest OCCT-native way to reproduce Fusion-style sketch behavior.
