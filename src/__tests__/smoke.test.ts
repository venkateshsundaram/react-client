import { defineConfig } from '../index';

test('defineConfig returns the same config object', () => {
  const cfg = { foo: 'bar' };
  expect(defineConfig(cfg)).toBe(cfg);
});
