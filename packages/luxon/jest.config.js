export default {
  displayName: "luxon",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  // babel.config.cjs sits at the repository root
  transform: {
    "^.+\\.[jt]s$": ["babel-jest", { rootMode: "upward" }],
  },
  // temporal-polyfill ships ESM only; let babel turn it into CJS for Jest's module system
  transformIgnorePatterns: ["/node_modules/(?!temporal-polyfill|temporal-spec|temporal-utils)"],
  // source files import siblings with a .js extension (ESM best practice); map them back to .ts
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  setupFilesAfterEnv: ["<rootDir>/test/setupTests.js"],
};
