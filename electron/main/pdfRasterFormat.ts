// Kept apart from the worker client: the raster worker imports it, and sharing a module with the
// client would move the client (and its `__dirname`-relative worker path) into a shared chunk.

/** A raster image is a little-endian uint32 width and height, then straight RGBA rows. */
export const rasterHeaderBytes = 8
