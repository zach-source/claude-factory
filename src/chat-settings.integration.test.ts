import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runModelAsync } from './once'

test.skipIf(process.env.WUA3V_REAL_CLAUDE !== '1')(
  'wua3v real Claude retains chat guard',
  async () => {
    const root = join(import.meta.dir, '..', '.scratch', `chat-settings-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    const cli = join(import.meta.dir, '..', 'bin', 'factory')
    const version = Bun.spawnSync(['claude', '--version']).stdout.toString().trim()
    const requests: unknown[] = []
    let requested = false
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as any
        requests.push(body)
        const result = requested
        requested = true
        const content = result
          ? [{ type: 'text' as const, text: 'Probe complete.' }]
          : ['factory status', 'factory decide lifecycle-acme ship ok'].map((command, i) => ({
              type: 'tool_use' as const,
              id: `toolu_probe${requests.length}_${i}`,
              name: 'Bash',
              input: { command },
            }))
        const message = {
          id: 'msg_probe',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content,
          stop_reason: result ? 'end_turn' : 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }
        if (!body.stream) return Response.json(message)
        const events: [string, unknown][] = [
          [
            'message_start',
            { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
          ],
        ]
        content.forEach((block, index) => {
          events.push([
            'content_block_start',
            {
              type: 'content_block_start',
              index,
              content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' },
            },
          ])
          events.push([
            'content_block_delta',
            {
              type: 'content_block_delta',
              index,
              delta:
                block.type === 'tool_use'
                  ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
                  : { type: 'text_delta', text: block.text },
            },
          ])
          events.push(['content_block_stop', { type: 'content_block_stop', index }])
        })
        events.push([
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: message.stop_reason, stop_sequence: null },
            usage: { output_tokens: 10 },
          },
        ])
        events.push(['message_stop', { type: 'message_stop' }])
        return new Response(
          events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      },
    })
    const rows: unknown[] = []
    const oldClaude = process.env.FACTORY_CLAUDE
    process.env.FACTORY_CLAUDE = 'claude'
    try {
      for (const restricted of [false, true]) {
        for (const files of [
          [],
          ['settings.json'],
          ['settings.local.json'],
          ['settings.json', 'settings.local.json'],
        ]) {
          for (const timing of ['before', 'resume']) {
            const dir = join(root, `${restricted}-${files.join('-') || 'none'}-${timing}`)
            const home = join(dir, 'home')
            const config = join(dir, 'config')
            const bin = join(dir, 'bin')
            for (const path of [home, config, bin, join(home, '.claude')])
              mkdirSync(path, { recursive: true })
            const calls = join(dir, 'calls.jsonl')
            const downstream = join(dir, 'downstream.txt')
            const marker = join(dir, 'project.txt')
            const wrapper = join(dir, 'guard.ts')
            writeFileSync(
              wrapper,
              `import {appendFileSync} from 'node:fs';
const input = await Bun.stdin.text();
const p = Bun.spawnSync([${JSON.stringify(cli)}, 'chat-guard'], {stdin: Buffer.from(input), env: {...process.env, FACTORY_SELF_UPDATE: '0'}});
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({id: JSON.parse(input).tool_use_id, code: p.exitCode, err: p.stderr.toString()}) + '\\n');
process.stderr.write(p.stderr); process.exit(p.exitCode);
`,
            )
            writeFileSync(join(bin, 'factory'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${downstream}'\n`)
            chmodSync(join(bin, 'factory'), 0o755)
            const seed = (disable: boolean) => {
              for (const file of files)
                writeFileSync(
                  join(home, '.claude', file),
                  JSON.stringify({
                    disableAllHooks: disable,
                    hooks: {
                      PreToolUse: [
                        {
                          matcher: 'Bash',
                          hooks: [{ type: 'command', command: `printf project >> '${marker}'` }],
                        },
                      ],
                    },
                  }),
                )
            }
            const base = {
              system: 'Use Bash to execute the two requested commands.',
              input: 'Run factory status and factory decide lifecycle-acme ship ok.',
              model: 'claude-sonnet-4-6',
              tools: 'Bash',
              maxTurns: 4,
              timeoutMs: 25_000,
              persist: true,
              cwd: home,
              settings: {
                hooks: {
                  PreToolUse: [
                    {
                      matcher: 'Bash',
                      hooks: [{ type: 'command', command: `${process.execPath} '${wrapper}'` }],
                    },
                  ],
                },
              },
              baseEnv: {
                PATH: `${bin}:${process.env.PATH}`,
                HOME: home,
                CLAUDE_CONFIG_DIR: config,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
                ANTHROPIC_API_KEY: 'probe-key',
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                FACTORY_SELF_UPDATE: '0',
              },
              ...(restricted ? { settingSources: 'user' as const } : {}),
            }
            if (timing === 'before') seed(true)
            requested = false
            const first = await runModelAsync(base)
            if (timing === 'resume') seed(true)
            requested = false
            const second = first.session ? await runModelAsync({ ...base, resume: first.session }) : undefined
            const hooks = existsSync(calls)
              ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length
              : 0
            const actual = existsSync(downstream) ? readFileSync(downstream, 'utf8').trim().split('\n') : []
            rows.push({
              restricted,
              files,
              timing,
              first: first.reason,
              error: first.error,
              second: second?.reason,
              hooks,
              downstream: actual,
            })
            writeFileSync(join(root, 'evidence.json'), JSON.stringify({ version, rows }, null, 2))
            expect(first.isOk).toBe(true)
            expect(first.calls).toHaveLength(2)
            expect(second?.isOk).toBe(true)
            expect(second?.calls).toHaveLength(2)
            if (restricted || files.length === 0) {
              expect(hooks).toBe(4)
              expect(actual).toEqual(['status', 'status'])
              expect(existsSync(marker)).toBe(false)
            }
            seed(false)
            requested = false
            const benign = await runModelAsync({ ...base, resume: first.session })
            expect(benign.isOk).toBe(true)
            expect(benign.calls).toHaveLength(2)
            expect(existsSync(marker)).toBe(!restricted && files.length > 0)
            if (restricted || files.length === 0) {
              const records = readFileSync(calls, 'utf8')
                .trim()
                .split('\n')
                .map(l => JSON.parse(l))
              const attempted = [...first.calls, ...second!.calls, ...benign.calls]
              expect(records).toHaveLength(attempted.length)
              for (const call of attempted) {
                const record = records.find(r => r.id === call.id)
                expect(record?.code).toBe(call.command === 'factory status' ? 0 : 2)
                if (call.command !== 'factory status')
                  expect(record.err).toContain('the person must approve this command')
              }
              expect(readFileSync(downstream, 'utf8')).toBe('status\nstatus\nstatus\n')
            }
          }
        }
      }
      const results = requests.flatMap((r: any) => r.messages ?? []).flatMap((m: any) => m.content ?? [])
      expect(
        results.some(
          (b: any) => b.type === 'tool_result' && JSON.stringify(b).includes('the person must approve'),
        ),
      ).toBe(true)
      console.log(JSON.stringify({ version, evidence: join(root, 'evidence.json'), cases: rows.length }))
    } finally {
      if (oldClaude === undefined) delete process.env.FACTORY_CLAUDE
      else process.env.FACTORY_CLAUDE = oldClaude
      server.stop(true)
    }
  },
  600_000,
)
