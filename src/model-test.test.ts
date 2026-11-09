import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { memoryModelMissing } from './model-test'

test('local model tests require a complete cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-model-test-'))
  const root = pathToFileURL(dir + '/')
  const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
  try {
    expect(memoryModelMissing(root, '')).toBe(true)
    mkdirSync(join(dir, 'onnx'))
    for (const file of files) writeFileSync(join(dir, file), '{}')
    expect(memoryModelMissing(root, '')).toBe(false)
    for (const file of files) {
      rmSync(join(dir, file))
      expect(memoryModelMissing(root, '')).toBe(true)
      writeFileSync(join(dir, file), '{}')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CI runs model tests even without a cache', () => {
  expect(memoryModelMissing(new URL('./absent-model/', import.meta.url), 'true')).toBe(false)
})
