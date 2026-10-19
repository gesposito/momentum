/* global test expect */
import { Zone } from "../../src/momentum";

test("You can instantiate Zone directly", () => {
  expect(() => new Zone().isValid).toThrow();
});
