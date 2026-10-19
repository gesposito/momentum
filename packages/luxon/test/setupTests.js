// Test setup, run before every test file (Jest: setupFilesAfterEnv, Bun: bunfig.toml preload).

// The library relies on the Temporal API. Runtimes without a native implementation (Node.js before
// 26, and Node.js builds against the system ICU before 26.12) get the polyfill installed on the
// global object here, exactly as a consumer would do with `@momentum-js/luxon/polyfill`. Setting
// MOMENTUM_TEMPORAL=polyfill forces the polyfill even where Temporal is native, so both engines
// can be exercised.
if (process.env.MOMENTUM_TEMPORAL === "polyfill") {
  globalThis.Temporal = require("temporal-polyfill/implementation").Temporal;
} else if (typeof globalThis.Temporal === "undefined") {
  require("temporal-polyfill/global");
}

// MOMENTUM_TEMPORAL_NATIVE=false runs the tests with Luxon's algorithms instead of the
// Temporal-native core (Settings.temporalNative = false). Tests written for one of the two set it
// themselves.
if (process.env.MOMENTUM_TEMPORAL_NATIVE === "false") {
  require("../src/momentum").Settings.temporalNative = false;
}

expect.extend({
  toMatchIgnoringWeirdSpaces(received, expected) {
    const replaceNbspReceived = (str) => str.replace(/\s/g, " ");
    const replaceNbspExpected = (str) => str.replace(/\s/g, " ");

    const pass = replaceNbspReceived(received) === replaceNbspExpected(expected);

    return {
      pass,
      message: () =>
        pass
          ? `Expected ${String(received)} to be (ignorning weird spaces) ${String(expected)}`
          : `Expected ${String(received)} to be (ignorning weird spaces) ${String(expected)}`,
    };
  },
});
