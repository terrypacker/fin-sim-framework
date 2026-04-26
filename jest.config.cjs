/**
 * Jest configuration for visualization tests that require a DOM environment.
 * Uses jsdom to provide document/window globals.
 * Run with: npm run test:viz
 */
module.exports = {
  testEnvironment: 'jsdom',
  moduleFileExtensions: ['js', 'mjs', 'cjs'],
  transform: {},
  roots: ['<rootDir>/tests/viz'],
  moduleNameMapper: {
    // Stub out chart.js and its plugins so BaseApp can be imported without a
    // real canvas context.  Tests that exercise chart rendering use separate
    // files that set up their own canvas stubs.
    '^chart\\.js$': '<rootDir>/tests/__mocks__/chart.js.cjs',
    '^chartjs-plugin-annotation$': '<rootDir>/tests/__mocks__/chartjs-plugin.cjs',
    '^chartjs-plugin-zoom$': '<rootDir>/tests/__mocks__/chartjs-plugin.cjs',
  }
};
