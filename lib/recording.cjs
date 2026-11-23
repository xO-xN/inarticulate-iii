// PNDS recording adapter protocol 1. Musical meaning stays in the work.
const { randomUUID } = require('node:crypto');
const clone = value => JSON.parse(JSON.stringify(value));
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 160;

function createRecordingAdapter({ adapterId, snapshot, restore, apply, release, advance = () => {} }) {
  const sources = new Map();
  const endedOperations = new Set();
  let active = null, lastEnded = null, queue = Promise.resolve();
  function elapsed() { return active ? Math.max(0, Math.floor(performance.now() - active.startedAt)) : 0; }
  function mappedId(sourceId) {
    if (!active || active.mode === 'record') return sourceId;
    if (active.mode === 'playback') return null;
    if (active.passId) {
      if (!sources.has(sourceId)) return null;
      if (!active.sourceIds.has(sourceId)) active.sourceIds.set(sourceId, randomUUID());
      return active.sourceIds.get(sourceId);
    }
    if (!active.liveSourceId) active.liveSourceId = sourceId;
    return active.liveSourceId === sourceId ? active.livePerformerId : null;
  }
  function admitted(sourceId) {
    return !active || active.mode === 'record' || mappedId(sourceId) !== null;
  }
  function remember(sourceId) {
    const id = mappedId(sourceId), source = sources.get(sourceId);
    if (!id || !source) return null;
    active.performers.set(id, { id, label: source.label, selection: clone(source.selection) });
    return id;
  }
  function capture(sourceId, kind, payload) {
    if (!active || active.mode === 'playback') return admitted(sourceId);
    const id = sourceId === null ? null : remember(sourceId);
    if (sourceId !== null && !id) return false;
    if (sourceId === null && active.mode !== 'record') return false;
    if (active.events.length >= 1_000_000) {
      active.fault = 'Recording event limit reached; stop and save this pass';
      return true; // Keep the live work running; the next App poll reports failure.
    }
    active.events.push({ atMs: active.captureAt ?? elapsed(), sequence: ++active.sequence, performerId: id, kind, payload: clone(payload) });
    return true;
  }
  function register(sourceId, label, selection = null) {
    sources.delete(sourceId);
    sources.set(sourceId, { label, selection: clone(selection), online: true });
    if (active && active.mode !== 'playback' && admitted(sourceId)) {
      remember(sourceId);
      capture(sourceId, 'join', { label, selection });
    }
  }
  function selection(sourceId, value) {
    const source = sources.get(sourceId);
    if (!source) return;
    if (JSON.stringify(source.selection) === JSON.stringify(value)) return;
    source.selection = clone(value);
    capture(sourceId, 'selection', value);
  }
  function unregister(sourceId) {
    const source = sources.get(sourceId);
    if (source) source.online = false;
    capture(sourceId, 'leave', null);
  }
  function result(afterSequence = 0) {
    return { protocolVersion: 1, adapterId, elapsedMs: elapsed(),
      passId: active.passId,
      performers: [...active.performers.values()].map(clone),
      events: active.events.filter(event => event.sequence > afterSequence).map(clone) };
  }
  async function command(body) {
    if (!body || typeof body !== 'object' || !validId(body.operationId)) throw new Error('Invalid recording operation');
    if (body.action === 'begin') {
      if (endedOperations.has(body.operationId)) throw new Error('Recording operation has ended');
      if (active) throw new Error('Another recording operation is active');
      if (!['record', 'playback', 'overdub'].includes(body.mode)) throw new Error('Invalid recording mode');
      if (body.livePassId !== undefined && !validId(body.livePassId)) throw new Error('Invalid recording pass');
      if (body.mode === 'overdub' && !validId(body.livePassId) && !validId(body.livePerformerId)) throw new Error('Missing overdub performer');
      if (body.mode !== 'record' && (!body.initialState || !Array.isArray(body.replayPerformers))) throw new Error('Missing replay initial state');
      const recent = [...sources].reverse().find(([, source]) => source.online)?.[0] ?? null;
      active = { operationId: body.operationId, mode: body.mode, startedAt: performance.now(),
        passId: body.mode === 'playback' ? null : body.livePassId ?? null, sourceIds: new Map(),
        liveSourceId: body.mode === 'overdub' ? recent : null, livePerformerId: body.livePerformerId,
        performers: new Map(), events: [], sequence: 0, drivenSequences: new Set(), drivenElapsed: 0 };
      try {
        const initialState = body.mode === 'record' ? clone(snapshot()) : clone(body.initialState);
        if (body.mode === 'record') {
          for (const [id, source] of sources) if (source.online) remember(id);
        } else {
          await restore(initialState, clone(body.replayPerformers), active.liveSourceId);
          if (body.mode === 'overdub' && active.passId) {
            active.captureAt = 0;
            for (const [id, source] of sources) if (source.online) {
              capture(id, 'join', { label: source.label, selection: source.selection });
            }
            active.captureAt = undefined;
          } else if (body.mode === 'overdub' && recent) remember(recent);
        }
        active.startedAt = performance.now();
        return { ...result(), initialState };
      } catch (error) { active = null; await release(); throw error; }
    }
    // A lost/rejected begin is still followed by end. Acknowledge an inactive
    // operation and revoke its ID so even a delayed begin cannot acquire it.
    if (!active && body.action === 'end') {
      if (typeof body.release !== 'boolean') throw new Error('Invalid recording release');
      endedOperations.add(body.operationId);
      if (lastEnded?.operationId === body.operationId) return clone(lastEnded.response);
      return { protocolVersion: 1, adapterId, elapsedMs: 0, performers: [], events: [] };
    }
    if (!active || body.operationId !== active.operationId) {
      if (body.action === 'end' && lastEnded?.operationId === body.operationId) return clone(lastEnded.response);
      throw new Error('Stale recording operation');
    }
    if (active.fault && body.action !== 'end') throw new Error(active.fault);
    if (body.action === 'poll') {
      if (!Number.isSafeInteger(body.afterSequence) || body.afterSequence < 0) throw new Error('Invalid recording cursor');
      return result(body.afterSequence);
    }
    if (body.action === 'drive') {
      if (active.mode === 'record' || !Array.isArray(body.events) || !Number.isFinite(body.elapsedMs) || body.elapsedMs < active.drivenElapsed) throw new Error('Invalid replay drive');
      for (const event of body.events) {
        if (!event || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !Number.isFinite(event.atMs) || event.atMs < 0 || event.atMs > body.elapsedMs || typeof event.kind !== 'string') throw new Error('Invalid replay event');
        if (active.drivenSequences.has(event.sequence)) continue;
        await apply(clone(event));
        active.drivenSequences.add(event.sequence);
      }
      await advance(body.elapsedMs);
      active.drivenElapsed = body.elapsedMs;
      return result(active.sequence);
    }
    if (body.action === 'end') {
      if (typeof body.release !== 'boolean') throw new Error('Invalid recording release');
      const boundary = active.mode !== 'record' && Number.isFinite(body.elapsedMs) && body.elapsedMs >= 0
        ? Math.floor(Math.min(body.elapsedMs, elapsed())) : elapsed();
      if (body.release && active.mode === 'overdub') {
        active.captureAt = boundary;
        const liveSources = active.passId ? active.sourceIds.keys() : active.liveSourceId ? [active.liveSourceId] : [];
        for (const id of liveSources) capture(id, 'release', null);
        active.captureAt = undefined;
      }
      const response = result(Number.isSafeInteger(body.afterSequence) ? body.afterSequence : 0);
      response.elapsedMs = boundary;
      if (body.release) await release();
      endedOperations.add(active.operationId);
      lastEnded = { operationId: active.operationId, response };
      active = null;
      return response;
    }
    throw new Error('Unknown recording action');
  }
  async function handle(request, response) {
    if (new URL(request.url, 'http://localhost').pathname !== '/__pnds/recording') return false;
    const host = request.headers.host?.split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.headers.origin) {
      response.writeHead(403); response.end(); return true;
    }
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET') { response.end(JSON.stringify({ protocolVersion: 1, adapterId })); return true; }
    if (request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) { response.writeHead(405); response.end(); return true; }
    try {
      let bytes = 0, data = '';
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) throw new Error('Recording request is too large');
        data += chunk;
      }
      const body = JSON.parse(data);
      const pending = queue.then(() => command(body));
      queue = pending.catch(() => {});
      response.end(JSON.stringify(await pending));
    } catch (error) {
      response.writeHead(409);
      response.end(JSON.stringify({ error: error.message }));
    }
    return true;
  }
  return { handle, register, unregister, selection, capture, admitted,
    get conductorAllowed() { return !active || active.mode === 'record'; },
    get mode() { return active?.mode ?? null; },
    get passId() { return active?.passId ?? null; },
    newSourceId() { return randomUUID(); } };
}
module.exports = { createRecordingAdapter };
