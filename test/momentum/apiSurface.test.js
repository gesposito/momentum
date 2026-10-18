/* global test expect */
import * as lib from "../../src/momentum";

// Every exported class with its static and prototype members (data properties, methods, getters
// and symbol-keyed methods alike). The snapshot was generated from Luxon's own implementation;
// a change here is a change to the public API and must be deliberate.

const skipped = new Set(["length", "name", "prototype", "constructor"]);

function memberNames(obj) {
  return [
    ...Object.getOwnPropertyNames(obj),
    ...Object.getOwnPropertySymbols(obj).map((s) => s.toString()),
  ]
    .filter((n) => !skipped.has(n))
    .sort();
}

test("the public API surface matches Luxon's", () => {
  const surface = { exports: Object.keys(lib).sort() };
  for (const name of surface.exports) {
    const value = lib[name];
    if (typeof value === "function") {
      surface[name] = { static: memberNames(value), prototype: memberNames(value.prototype) };
    }
  }
  expect(surface).toMatchSnapshot();
});
