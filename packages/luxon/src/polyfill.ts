// Entry point for runtimes without a native Temporal implementation. It installs the
// `temporal-polyfill` on the global object (a no-op where Temporal already exists) and then
// re-exports the library. This is the only module in the package with import-time side effects.
import "temporal-polyfill/global";

export * from "./momentum.js";
