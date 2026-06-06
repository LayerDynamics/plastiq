/** Determines how the voxels are filled to create a solid object. The default - "flood" - generally works fine
 * for closed meshes. However, if the mesh is not watertight, then using "raycast" may be preferable as it will
 * determine if a voxel is part of the interior of the source mesh by raycasting around it. Finally, there are
 * some cases where you might actually want a convex decomposition to treat the source mesh as being hollow. If
 * that is the case you can use "surface" and then the convex decomposition will converge only onto the 'skin'
 * of the surface mesh.
 */
export declare type HullFillMode = "flood" | "surface" | "raycast";
/** Specifies what types of messages are output to the console during convex hull decomposition.
 * "progress" outputs the stages and operations as they occur.
 * "log" outputs warnings and informational messages.
 * "all" outputs both "progress" and "log" messages.
 * "none" outputs no messages.
 */
export declare type MessageType = "none" | "progress" | "log" | "all";
/** Options controlling how ConvexMeshDecomposition is performed. */
export interface Options {
    /** The maximum number of convex hulls to produce.
     * Default: 64.
     */
    maxHulls?: number;
    /** The voxel resolution to use.
     * Default: 400000.
     */
    voxelResolution?: number;
    /** If the voxels are within 1% of the volume of the hull, we consider this a close enough approximation.
     * Default: 1.
     */
    minVolumePercentError?: number;
    /** The maximum recursion depth.
     * Default: 10.
     */
    maxRecursionDepth?: number;
    /** Whether or not to shrinkwrap the voxel positions to the source mesh on output.
     * Default: true.
     */
    shrinkWrap?: boolean;
    /** How to fill the interior of the voxelized mesh.
     * Default: "flood"
     */
    fillMode?: HullFillMode;
    /** The maximum number of vertices allowed in any output convex hull.
     * Default: 64.
     */
    maxVerticesPerHull?: number;
    /** Once a voxel patch has an edge length of less than 4 on all 3 sides, we don't keep recursing.
     * Default: 2.
     */
    minEdgeLength?: number;
    /** Whether or not to attempt to split planes along the best location.
     * Note: this is an experimental feature.
     * Default: false.
     */
    findBestPlane?: boolean;
    /** The types of messages to output to the console during convex hull decomposition.
     * Default: "none".
     */
    messages?: MessageType;
}
/** A triangle mesh. */
export interface Mesh {
    /** The positions of each vertex, arranged in consecutive triplets [x, y, z]. */
    positions: Float64Array;
    /** The triangles of the mesh as indices into `positions`, arranged in consecutive triplets [i, j, k]. */
    indices: Uint32Array;
}
/** An object that can produce convex hulls from Meshes.
 * Use `ConvexMeshDecomposition.create` to obtain one.
 */
export interface ConvexMeshDecomposition {
    /** Produce a list of convex hulls from the input mesh using the specified options. */
    computeConvexHulls(mesh: Readonly<Mesh>, options?: Options): Mesh[];
}
export declare namespace ConvexMeshDecomposition {
    /** Create a ConvexMeshDecomposition. */
    function create(): Promise<ConvexMeshDecomposition>;
}
//# sourceMappingURL=vhacd.d.ts.map