/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio.
 *
 * The official Codex provider gets this from
 * `@deepseek-ai/dsh-sdk-protocol`'s `JsonRpcLineTransport`. This plugin keeps
 * zero runtime dependencies, so the transport lives here — and it is a small,
 * well-understood piece: frame by line, correlate by id, surface every failure
 * instead of leaving a caller pending forever.
 *
 * Framing: one JSON object per line, `\n`-terminated, on both directions. A
 * partial line is buffered; a malformed line is reported and skipped, because a
 * protocol peer that emits one bad frame should not take the session down.
 *
 * @module dsh-subagent-codex-pro/jsonrpc
 */

/** One decoded JSON-RPC message. */
export interface JsonRpcMessage {
  readonly jsonrpc?: string
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown }
}

/** What the owner does with messages that are not responses. */
export interface TransportHooks {
  /**
   * Handle a request from the peer. The resolved value becomes its `result`; a
   * throw becomes its `error`.
   *
   * @param method - the JSON-RPC method.
   * @param params - its params.
   * @returns the result to send back.
   */
  onRequest?(method: string, params: unknown): Promise<unknown> | unknown
  /**
   * Handle a notification.
   *
   * @param method - the JSON-RPC method.
   * @param params - its params.
   */
  onNotification?(method: string, params: unknown): void
  /**
   * Report a transport-level failure (bad frame, write error).
   *
   * @param error - what went wrong.
   */
  onProblem?(error: Error): void
}

/** The writable side of a transport. */
export interface TransportWritable {
  write(chunk: string): unknown
}

/** The readable side of a transport. */
export interface TransportReadable {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

/** One in-flight request. */
interface Pending {
  /**
   * Settle this request exactly once.
   *
   * Every path — response, timeout, abort, dispose — goes through here, and none
   * of them may call a stored `resolve`/`reject` directly: those belong to the
   * Promise and are only reachable from the closure that created it.
   */
  finish(error?: Error, value?: unknown): void
  timer: NodeJS.Timeout | undefined
  abort: (() => void) | undefined
}

/** A JSON-RPC peer speaking one object per line. */
export class LineTransport {
  #nextId = 1
  #pending = new Map<number | string, Pending>()
  #buffer = ''
  #disposed: Error | undefined
  // Explicit fields rather than constructor parameter properties: Node's native
  // TypeScript support strips types only, and rejects that syntax, so a source
  // file the tests import must avoid it.
  readonly #toPeer: TransportWritable
  readonly #fromPeer: TransportReadable
  #hooks: TransportHooks

  constructor(toPeer: TransportWritable, fromPeer: TransportReadable, hooks: TransportHooks = {}) {
    this.#toPeer = toPeer
    this.#fromPeer = fromPeer
    this.#hooks = hooks
    fromPeer.on('data', (chunk) => {
      this.#ingest(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
  }

  /**
   * Replace the message hooks.
   *
   * The wire installs its handlers after construction, which keeps the transport
   * independent of the product methods layered on top of it.
   *
   * @param hooks - the handlers to install.
   */
  setHooks(hooks: TransportHooks): void {
    this.#hooks = hooks
  }

  /**
   * Wait until everything written so far has left this process.
   *
   * Writes go to the peer's stream synchronously, so there is nothing to drain;
   * the method exists because the protocol's handshake uses it as an explicit
   * write barrier between `initialized` and `thread/start`.
   *
   * @returns a promise that is already settled.
   */
  flush(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Send one request and await its response.
   *
   * @param method - the JSON-RPC method.
   * @param params - its params.
   * @param options - optional caller cancellation and a response deadline.
   * @returns the peer's `result`.
   */
  request(method: string, params: unknown, options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {}): Promise<unknown> {
    if (this.#disposed !== undefined) return Promise.reject(this.#disposed)
    const id = this.#nextId
    this.#nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      // Every path — response, timeout, abort, dispose — settles through here
      // exactly once. It must call the Promise's own `resolve`/`reject`, never a
      // stored wrapper: a wrapper that calls back into this function deletes the
      // pending entry and then does nothing, so the caller stays pending forever
      // while `pendingCount` reads zero.
      let settled = false
      const finish = (error?: Error, value?: unknown): void => {
        // Idempotence lives here, not in the pending map: `dispose` removes every
        // entry before settling it, so a map lookup would silently skip the very
        // requests it is trying to fail, and their callers would wait forever.
        if (settled) return
        settled = true
        this.#pending.delete(id)
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        entry.abort?.()
        if (error === undefined) resolve(value)
        else reject(error)
      }
      const entry: Pending = {
        finish,
        timer: undefined,
        abort: undefined,
      }
      this.#pending.set(id, entry)
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          entry.finish(new Error(`jsonrpc: "${method}" timed out after ${String(options.timeoutMs)} ms`))
        }, options.timeoutMs)
        entry.timer.unref?.()
      }
      const signal = options.signal
      if (signal !== undefined) {
        const onAbort = (): void => { entry.finish(abortFailure(method, signal)) }
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
        entry.abort = () => { signal.removeEventListener('abort', onAbort) }
      }
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /**
   * Send one notification; nothing is awaited.
   *
   * @param method - the JSON-RPC method.
   * @param params - its params.
   */
  notify(method: string, params?: unknown): void {
    if (this.#disposed !== undefined) return
    this.#write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /**
   * Fail every in-flight request and stop reading.
   *
   * @param reason - why the transport is going away.
   */
  dispose(reason = new Error('jsonrpc: transport disposed')): void {
    if (this.#disposed !== undefined) return
    this.#disposed = reason
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) {
      entry.finish(reason)
    }
  }

  /** How many requests are still awaiting a response. */
  get pendingCount(): number {
    return this.#pending.size
  }

  /** Write one message, reporting a broken pipe rather than throwing into a caller. */
  #write(message: JsonRpcMessage): void {
    try {
      this.#toPeer.write(`${JSON.stringify(message)}\n`)
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.#hooks.onProblem?.(failure)
      this.dispose(new Error(`jsonrpc: write failed: ${failure.message}`))
    }
  }

  /** Split one read chunk into lines and handle each complete one. */
  #ingest(chunk: string): void {
    this.#buffer += chunk
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line === '') continue
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch (error: unknown) {
        // One malformed frame is the peer's problem, not the session's.
        this.#hooks.onProblem?.(new Error(`jsonrpc: ignoring an undecodable line (${String(error)}): ${line.slice(0, 200)}`))
        continue
      }
      this.#handle(message)
    }
  }

  /** Route one decoded message to its response, request, or notification path. */
  #handle(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.#pending.get(message.id)
      if (entry === undefined) return
      if (message.error !== undefined) {
        const detail = message.error.data === undefined ? '' : `: ${JSON.stringify(message.error.data).slice(0, 400)}`
        entry.finish(new Error(`${message.error.message ?? 'jsonrpc error'} (code ${String(message.error.code ?? '?')})${detail}`))
        return
      }
      entry.finish(undefined, message.result)
      return
    }
    if (message.method === undefined) return
    if (message.id !== undefined) {
      // A request from the peer: it wants an answer.
      const id = message.id
      void Promise.resolve()
        .then(() => this.#hooks.onRequest?.(message.method as string, message.params))
        .then(
          (result) => { this.#write({ jsonrpc: '2.0', id, result: result ?? null }) },
          (error: unknown) => {
            this.#write({
              jsonrpc: '2.0',
              id,
              error: { code: -32_000, message: error instanceof Error ? error.message : String(error) },
            })
          },
        )
      return
    }
    this.#hooks.onNotification?.(message.method, message.params)
  }
}

/**
 * Describe an aborted request.
 *
 * @param method - the method that was cancelled.
 * @param signal - the signal that fired.
 * @returns the failure to reject with.
 */
function abortFailure(method: string, signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  const detail = reason instanceof Error ? `: ${reason.message}` : reason === undefined ? '' : `: ${String(reason)}`
  return new Error(`jsonrpc: "${method}" was aborted${detail}`)
}
