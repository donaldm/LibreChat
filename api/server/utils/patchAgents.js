/**
 * Work around a race where tool error callbacks may fire after a graph
 * has already cleared its config. The upstream implementation throws in
 * this situation, which aborts streaming and prevents responses from
 * reaching the UI. We defensively restore/skip when config is missing
 * to keep the pipeline alive while still emitting tool error details.
 */
const path = require('path');
const { StandardGraph } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');

let EventStreamCallbackHandler;

try {
  // Resolve from package root to avoid relying on non-exported subpaths.
  const corePackagePath = require.resolve('@langchain/core/package.json');
  const eventStreamPath = path.join(
    path.dirname(corePackagePath),
    'dist',
    'tracers',
    'event_stream.cjs',
  );
  ({ EventStreamCallbackHandler } = require(eventStreamPath));
} catch (error) {
  logger?.warn?.('[patchAgents] failed to load EventStreamCallbackHandler', error);
}

const originalHandleToolCallErrorStatic = StandardGraph.handleToolCallErrorStatic?.bind(StandardGraph);

if (typeof originalHandleToolCallErrorStatic === 'function') {
  StandardGraph.handleToolCallErrorStatic = async (graph, data, metadata) => {
    if (!graph?.config) {
      // Attempt to recover using the current metadata; if unavailable, skip
      // handling to avoid throwing and interrupting the stream.
      const recoveredConfig = metadata?.config;
      if (recoveredConfig) {
        graph.config = recoveredConfig;
      } else {
        return;
      }
    }

    return originalHandleToolCallErrorStatic(graph, data, metadata);
  };
}

const originalSend = EventStreamCallbackHandler?.prototype?.send;
const originalFinish = EventStreamCallbackHandler?.prototype?.finish;

// Track closure and warning per handler instance to avoid repeated logs.
const CLOSED_FLAG = Symbol('event_stream_writer_closed');
const WARNED_FLAG = Symbol('event_stream_writer_warned');
const CLOSED_PROMISE_ATTACHED = Symbol('event_stream_writer_closed_promise');

if (typeof originalSend === 'function') {
  EventStreamCallbackHandler.prototype.send = async function send(payload, run) {
    if (this?.writer && !this[CLOSED_PROMISE_ATTACHED]) {
      this[CLOSED_PROMISE_ATTACHED] = true;
      this.writer.closed
        ?.catch(() => {})
        ?.finally(() => {
          this[CLOSED_FLAG] = true;
        });
    }

    if (!this?.writer || this[CLOSED_FLAG]) {
      if (!this[WARNED_FLAG]) {
        logger?.warn?.('[EventStreamCallbackHandler.send] writer is closed or missing; dropping event');
        this[WARNED_FLAG] = true;
      }
      return;
    }

    try {
      return await originalSend.call(this, payload, run);
    } catch (error) {
      if (!this[WARNED_FLAG]) {
        logger?.warn?.('[EventStreamCallbackHandler.send] swallowed send error', error);
        this[WARNED_FLAG] = true;
      }
    }
  };
}

if (typeof originalFinish === 'function') {
  EventStreamCallbackHandler.prototype.finish = async function finish(...args) {
    try {
      return await originalFinish.apply(this, args);
    } catch (error) {
      if (!this[WARNED_FLAG]) {
        logger?.warn?.('[EventStreamCallbackHandler.finish] swallowed finish error', error);
        this[WARNED_FLAG] = true;
      }
    } finally {
      this[CLOSED_FLAG] = true;
    }
  };
}
