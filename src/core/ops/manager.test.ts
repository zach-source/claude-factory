import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Ctx } from '../catalog'
import { context, contextOf, projectDir } from './manager'

const turn = (model: string, i: number, w: number, r: number, o: number) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      model,
      usage: {
        input_tokens: i,
        cache_creation_input_tokens: w,
        cache_read_input_tokens: r,
        output_tokens: o,
      },
    },
  })

test('contextOf takes the last assistant turn: model, tokens and percent of the window', () => {
  const text = [
    turn('m-old', 1, 1, 1, 1),
    '{"type":"user"}',
    turn('m-new', 2, 573, 53915, 639),
    'half a li',
  ].join('\n')
  expect(contextOf(text)).toEqual({ model: 'm-new', tokens: 55129, window: 200000, percent: 27.6 })
})

test('contextOf moves to the 1M window when the use is over 200k, and skips a synthetic turn', () => {
  const text = [turn('m', 0, 0, 300000, 0), turn('<synthetic>', 0, 0, 0, 0)].join('\n')
  expect(contextOf(text)).toEqual({ model: 'm', tokens: 300000, window: 1_000_000, percent: 30 })
  expect(contextOf('{"type":"user"}\nnot json')).toBeUndefined()
})

test('manager.context reads the newest transcript of the project of the home parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-'))
  const home = join(root, 'w', 'home')
  const dir = join(root, 'cfg', 'projects', projectDir(join(root, 'w')))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.jsonl'), turn('m', 100, 0, 0, 0) + '\n')
  const ctx = {
    home,
    env: { CLAUDE_CONFIG_DIR: join(root, 'cfg'), FACTORY_MANAGER_WINDOW: '1000' },
  } as unknown as Ctx
  const r = await context(ctx, {})
  expect(JSON.parse(r.out)).toMatchObject({ model: 'm', tokens: 100, window: 1000, percent: 10 })
  const none = {
    home: join(root, 'x', 'home'),
    env: { CLAUDE_CONFIG_DIR: join(root, 'cfg') },
  } as unknown as Ctx
  expect((await context(none, {})).out.trim()).toBe('null')
})
