#!/usr/bin/env node
// The published command, `momentum-migrate` (package @momentum-js/migrate): cli.ts bundled by
// scripts/build.ts with the momentum it was proven against. The catalog evaluates literal
// arguments with momentum, which needs Temporal; temporal-polyfill installs itself where it is
// missing (Node before 26) and does nothing elsewhere.
import "temporal-polyfill/global";
import "./cli.js";
