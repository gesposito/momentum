export default {
  displayName: "migrate",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  // babel.config.cjs sits at the repository root
  transform: {
    "^.+\\.[jt]s$": ["babel-jest", { rootMode: "upward" }],
  },
  // temporal-polyfill ships ESM only; let babel turn it into CJS for Jest's module system
  transformIgnorePatterns: ["/node_modules/(?!temporal-polyfill|temporal-spec|temporal-utils)"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  // the library's setup: the polyfill where Temporal is missing or forced, the opt-out core
  setupFilesAfterEnv: ["<rootDir>/../luxon/test/setupTests.js"],
};
