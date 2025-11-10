/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',  // ✅ ESM-ready
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.test.json',
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'], // ✅ makes Jest treat TS as ESM
  transformIgnorePatterns: [
    'node_modules/(?!(@react-client|chalk|kleur|fs-extra|open)/)', // ✅ allow modern ESM deps
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  verbose: true,
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
