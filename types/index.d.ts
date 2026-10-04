// Type contract for the values the wisply-local mod keeps in $.state.
// Status metadata only: transcript text is never stored in state.

export type WisplyPhase =
  | 'checking'
  | 'recording'
  | 'paused'
  | 'idle'
  | 'unknown'
  | 'setup'
  | 'offline'
  | 'unverified'
  | 'disconnected'

export type WisplyStatus = {
  phase: WisplyPhase
  durationSeconds: number
  wordCount: number
}

declare module 'claude-code' {
  interface PluginState {
    'wisply-local': { status: WisplyStatus }
  }
}
