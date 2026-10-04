// Wisply mod for Claude Code: a status line entry with Wisply's recording
// state, a band with a "quote" button while recording, and the
// /wisply-quote and /wisply-status commands.
//
// The mod makes no network requests of its own. It reads get_live_transcript
// through this plugin's own `wisply` MCP server (bridge.mjs), so the fixed
// 127.0.0.1:51771 endpoint, the token checks and the timeouts live in one
// place. Claude Code hands register() every option the manifest declares,
// the sensitive token included; the mod reads only live_status and
// quote_words, and never reads, stores, logs or sends the token or the
// options object.
//
// Each status read makes the bridge send the token to whatever is listening
// on the port, so the mod never checks on its own at session start. It
// starts checking only after the person uses Wisply in the session (one of
// the two commands, or a Wisply tool call that succeeded), and stops again
// once Wisply stops answering. Transcript text is fetched only for the
// quote action, is inserted into the prompt box for the person to read and
// send (or delete), and is never stored or logged.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WisplyPhase, WisplyStatus } from '../types'
import {
  buildExcerpt,
  clampQuoteWords,
  classifyFailure,
  describeStatus,
  formatBandLabel,
  formatStatusLine,
  nextPollDelayMs,
  parseLiveTranscript,
} from '../lib/shared.mjs'

type Snapshot = NonNullable<ReturnType<typeof parseLiveTranscript>>
type LiveRead = { ok: true; snapshot: Snapshot } | { ok: false; phase: WisplyPhase }

const SERVER_KEY = 'wisply'
const LIVE_TOOL = 'get_live_transcript'
const CALL_TIMEOUT_MS = 6000
const FIRST_POLL_MS = 1500

const INITIAL: WisplyStatus = { phase: 'checking', durationSeconds: 0, wordCount: 0 }
const status = atom({ plugin: 'wisply-local', key: 'status' } as const, INITIAL)

const toStatus = (snapshot: Snapshot): WisplyStatus => ({
  phase: snapshot.state,
  durationSeconds: Math.floor(snapshot.durationSeconds),
  wordCount: snapshot.wordCount,
})

const isLive = (phase: WisplyPhase) => phase === 'recording' || phase === 'paused'
const isAnswering = (phase: WisplyPhase) => isLive(phase) || phase === 'idle' || phase === 'unknown'

const failureText = (phase: WisplyPhase) =>
  phase === 'setup' || phase === 'offline' || phase === 'disconnected'
    ? describeStatus({ phase })
    : 'Wisply did not return a live transcript.'

// Module state. A reload starts it over and drops the previous load's timers;
// session.start then resumes checking if this session was already checking.
const poller: {
  showLiveStatus: boolean
  quoteWords: number
  serverName: string | undefined
  timer: { cancel: () => void } | undefined
  failures: number
  isPolling: boolean
} = {
  showLiveStatus: true,
  quoteWords: 80,
  serverName: undefined,
  timer: undefined,
  failures: 0,
  isPolling: false,
}

async function withTimeout<T>($: EngineInterface, work: Promise<T>): Promise<T> {
  const settled = new AbortController()
  const expiry = $.clock.sleep(CALL_TIMEOUT_MS, { signal: settled.signal }).then(() => {
    throw new Error('Local Wisply did not answer in time')
  })
  // The race below reads the expiry; this keeps its abort from surfacing
  // as an unhandled rejection once the race has settled.
  expiry.catch(() => undefined)
  try {
    return await Promise.race([work, expiry])
  } finally {
    settled.abort()
  }
}

async function readLive($: EngineInterface): Promise<LiveRead> {
  try {
    if (!poller.serverName) {
      const connected = await $.mcp.connect(SERVER_KEY)
      if (!connected.isConnected) return { ok: false, phase: 'disconnected' }
      poller.serverName = connected.server
    }
    const result = await withTimeout($, $.mcp.call(poller.serverName, LIVE_TOOL, {}))
    if (result.isError) {
      const text = result.content.map(block => (typeof block.text === 'string' ? block.text : '')).join(' ')
      return { ok: false, phase: classifyFailure(text) }
    }
    const snapshot = parseLiveTranscript(result)
    return snapshot ? { ok: true, snapshot } : { ok: false, phase: 'offline' }
  } catch (error) {
    return { ok: false, phase: classifyFailure(error) }
  }
}

async function publish($: EngineInterface, next: WisplyStatus) {
  if (poller.showLiveStatus) $.ui.status(formatStatusLine(next))
  const current = await read($, status)
  const isSame =
    current.phase === next.phase &&
    current.durationSeconds === next.durationSeconds &&
    current.wordCount === next.wordCount
  if (!isSame) await update($, status, () => next)
}

function schedule($: EngineInterface, delayMs: number) {
  poller.timer?.cancel()
  poller.timer = $.clock.after(delayMs, () => {
    poller.timer = undefined
    poll($).catch(() => undefined)
  })
}

// Plans the next background check from the latest result: keep checking
// while Wisply answers, retry twice once it stops, then stop until the
// person uses Wisply again.
function plan($: EngineInterface, phase: WisplyPhase) {
  poller.timer?.cancel()
  poller.timer = undefined
  if (!poller.showLiveStatus) return
  const delay = nextPollDelayMs(phase, poller.failures)
  if (delay !== null) schedule($, delay)
}

// Starts background checks after the person used Wisply, unless they are
// already running.
function arm($: EngineInterface, delayMs = FIRST_POLL_MS) {
  if (!poller.showLiveStatus || poller.timer || poller.isPolling) return
  schedule($, delayMs)
}

// One status read. A read that finds Wisply answering starts or continues
// the background checks; a failed one only continues checks that were
// already running (as retries), so a check the person ran while Wisply was
// off leaves nothing running behind it.
async function refresh($: EngineInterface, { isBackground }: { isBackground: boolean }): Promise<LiveRead> {
  const wasChecking = isBackground || poller.timer !== undefined
  const live = await readLive($)
  if (!live.ok && live.phase === 'disconnected') poller.serverName = undefined
  poller.failures = live.ok ? 0 : poller.failures + 1
  if (live.ok || wasChecking) plan($, live.ok ? live.snapshot.state : live.phase)
  await publish($, live.ok ? toStatus(live.snapshot) : { phase: live.phase, durationSeconds: 0, wordCount: 0 })
  return live
}

async function poll($: EngineInterface) {
  if (poller.isPolling) return
  poller.isPolling = true
  try {
    await refresh($, { isBackground: true })
  } finally {
    poller.isPolling = false
  }
}

// Reads the live transcript once, now, and inserts a labelled quote of its
// last `words` words at the cursor. Nothing is submitted.
async function quoteIntoPrompt($: EngineInterface, words: number): Promise<{ ok: boolean; message: string }> {
  const live = await refresh($, { isBackground: false })
  if (!live.ok) return { ok: false, message: failureText(live.phase) }
  if (!isLive(live.snapshot.state)) return { ok: false, message: 'Wisply is not recording, so there is nothing live to quote.' }
  const excerpt = buildExcerpt(live.snapshot.transcript, {
    maxWords: words,
    durationSeconds: live.snapshot.durationSeconds,
  })
  if (!excerpt) return { ok: false, message: 'The live transcript is empty so far.' }
  const filled = await $.prompt.fill({ text: excerpt.text, mode: 'insert' })
  if (!filled.isFilled) {
    return {
      ok: false,
      message:
        filled.refusal === 'dialog'
          ? 'Close the open dialog, then quote again.'
          : 'There is no prompt box here to insert the excerpt into.',
    }
  }
  return {
    ok: true,
    message: `Inserted the last ${excerpt.words} words from Wisply into your prompt. Nothing was sent.`,
  }
}

async function quoteFromButton($: EngineInterface) {
  const outcome = await quoteIntoPrompt($, poller.quoteWords)
  $.ui.toast(outcome.message)
}

async function checkNow($: EngineInterface): Promise<string> {
  await refresh($, { isBackground: false })
  return describeStatus(await read($, status))
}

export const register: Register = (on, options) => {
  // Only these two options are read. `options` also holds the token; it is
  // never read, spread, serialized or logged here.
  poller.showLiveStatus = options.live_status !== false
  poller.quoteWords = clampQuoteWords(options.quote_words)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wisply-quote',
      description: 'Insert a labelled quote of the live Wisply transcript into the prompt (not sent)',
      argumentHint: '[words]',
      immediate: true,
    })
    await $.command.register({
      name: 'wisply-status',
      description: 'Check whether Wisply is recording (no transcript text)',
      immediate: true,
    })
    // A fresh session waits for the person. After a reload in a session
    // whose last check found Wisply answering, checking resumes.
    const last = await read($, status)
    if (isAnswering(last.phase)) arm($)
    return next(e)
  })

  // A Wisply tool call Claude made for the person that succeeded counts as
  // using Wisply: the status line starts then. The call itself is passed
  // through untouched.
  on(
    'tool.call',
    { tool: /^mcp__plugin_wisply-local_wisply__(?:list_memos|search_transcripts|get_live_transcript|get_action_items)$/ },
    async ($, e, next) => {
      const outcome = await next(e)
      if (outcome.deny === undefined && !outcome.isError) arm($)
      return outcome
    },
  )

  on('command.run', { command: 'wisply-quote' }, async ($, e) => {
    const outcome = await quoteIntoPrompt($, clampQuoteWords(e.args, poller.quoteWords))
    if (outcome.ok) {
      $.ui.toast(outcome.message)
      return {}
    }
    return { text: outcome.message }
  })

  on('command.run', { command: 'wisply-status' }, async $ => ({ text: await checkNow($) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!poller.showLiveStatus || e.props.hasSurvey) return next(e)
    const current = await read($, status)
    const label = formatBandLabel(current)
    if (!label) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor wrap="truncate-end">
          {label}
        </Text>
        {current.phase === 'recording' && (
          <Button
            key="wisply-quote"
            label={`Quote last ${poller.quoteWords} words`}
            onPress={() => quoteFromButton($)}
          />
        )}
      </Box>
    )
  })
}
