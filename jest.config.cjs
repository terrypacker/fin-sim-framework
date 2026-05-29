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
  }
};
