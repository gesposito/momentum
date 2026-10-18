module.exports = {
  testEnvironment: "node",
  roots: ["test"],
  coverageDirectory: "build/coverage",
  collectCoverageFrom: ["src/**/*.ts", "!src/zone.ts", "!src/polyfill.ts"],
  transform: {
    "^.+\\.[jt]s$": "babel-jest",
  },
  // temporal-polyfill ships ESM only; let babel turn it into CJS for Jest's module system
  transformIgnorePatterns: ["/node_modules/(?!temporal-polyfill|temporal-spec|temporal-utils)"],
  // source files import siblings with a .js extension (ESM best practice); map them back to .ts
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  setupFilesAfterEnv: ["<rootDir>/test/setupTests.js"],
};
