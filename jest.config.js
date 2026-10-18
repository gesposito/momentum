module.exports = {
  testEnvironment: "node",
  roots: ["test"],
  coverageDirectory: "build/coverage",
  collectCoverageFrom: ["src/**/*.js", "!src/zone.js"],
  transform: {
    "^.+\\.js$": "babel-jest",
  },
  // temporal-polyfill ships ESM only; let babel turn it into CJS for Jest's module system
  transformIgnorePatterns: ["/node_modules/(?!temporal-polyfill|temporal-spec|temporal-utils)"],
  setupFilesAfterEnv: ["<rootDir>/test/setupTests.js"],
};
