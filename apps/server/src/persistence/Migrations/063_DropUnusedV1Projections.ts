import * as Effect from "effect/Effect";

// Keep the historical migration id, but retain V1 history as the lazy import source.
// Checkpoint blobs and unresolved approvals also remain available for recovery;
// retaining a record must never reissue the old action in V2.
export default Effect.void;
