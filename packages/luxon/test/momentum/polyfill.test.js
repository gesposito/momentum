/* global test expect */
import { DateTime, VERSION } from "../../src/polyfill";

test("the polyfill entry point exposes the library and guarantees a Temporal global", () => {
  expect(typeof globalThis.Temporal).toBe("object");
  expect(typeof VERSION).toBe("string");
  expect(DateTime.fromISO("2017-05-15T09:12:34.567Z").toMillis()).toBe(1494839554567);
});
