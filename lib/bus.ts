/**
 * Typed in-process event bus. The store emits `team` and `message` after every
 * mutation and the log buffer emits `log`; consumers subscribe instead of
 * polling. Delivery is synchronous, so a listener that does real work should
 * defer it (queueMicrotask) rather than block, or re-enter the store, before the
 * remaining listeners have seen the event.
 */

import { EventEmitter } from 'events'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'
import type { LogEntry } from './log-buffer'

export interface BusEvents {
  /** A team was created or changed; the payload is its new state. */
  team: EnsembleTeam
  /** A message was appended to a team's feed (it carries its `teamId` and `seq`). */
  message: EnsembleMessage
  /** A line was written to the server console. */
  log: LogEntry
}

export type BusEventName = keyof BusEvents

class Bus {
  private readonly emitter = new EventEmitter()

  constructor() {
    // One listener per live subscriber (SSE streams later); the default 10 would warn.
    this.emitter.setMaxListeners(100)
  }

  /** Subscribe. Returns the function that unsubscribes. */
  on<K extends BusEventName>(event: K, listener: (payload: BusEvents[K]) => void): () => void {
    this.emitter.on(event, listener)
    return () => { this.emitter.off(event, listener) }
  }

  /**
   * Emit to every listener. A throwing listener is logged and does not stop the
   * others or reach the code that caused the event — the store emits from inside
   * its own mutations. (A throwing `log` listener stays silent: logging it would
   * emit another `log`.)
   */
  emit<K extends BusEventName>(event: K, payload: BusEvents[K]): void {
    for (const listener of this.emitter.listeners(event)) {
      try {
        listener(payload)
      } catch (err) {
        if (event !== 'log') console.error(`[Bus] '${event}' listener threw:`, err)
      }
    }
  }

  listenerCount(event: BusEventName): number {
    return this.emitter.listenerCount(event)
  }
}

export const bus = new Bus()
