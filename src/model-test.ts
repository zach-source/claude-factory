import { test } from 'bun:test'
import { existsSync } from 'node:fs'

const model = new URL('../.cache/Xenova/bge-small-en-v1.5/', import.meta.resolve('@huggingface/transformers'))

// CI downloads the model. Local tests need its complete q8 cache to avoid a network request.
// ponytail: bge q8 files only; update this list if the memory model changes.
export function memoryModelMissing(root = model, ci = process.env['CI']): boolean {
  return (
    !ci &&
    ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'].some(
      file => !existsSync(new URL(file, root)),
    )
  )
}

export const modelTest = test.skipIf(memoryModelMissing())
