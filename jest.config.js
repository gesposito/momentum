// One Jest run over both packages; the projects' own configuration sits next to each package.
export default {
  projects: ["<rootDir>/packages/luxon", "<rootDir>/packages/migrate"],
  coverageDirectory: "coverage",
  collectCoverageFrom: [
    "packages/luxon/src/**/*.ts",
    "!packages/luxon/src/zone.ts",
    "!packages/luxon/src/polyfill.ts",
  ],
};
