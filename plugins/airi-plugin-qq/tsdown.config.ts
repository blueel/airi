import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['./src/index.ts'],
    inlineOnly: [],
    platform: 'node',
    dts: true,
    unused: true,
    publint: true,
  },
])
