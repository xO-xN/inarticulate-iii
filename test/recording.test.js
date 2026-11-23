const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const dgram = require('node:dgram');
const { io } = require('socket.io-client');
const { events: E } = require('../public/shared');
const { createRecordingAdapter } = require('../lib/recording.cjs');
const { runtimeFixture } = require('./support/runtime.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  const end = performance.now() + 4000;
  while (performance.now() < end) { const value = await read(); if (value) return value; await delay(10); }
  throw new Error('Timed out waiting for observable III state');
}
async function fixture(t, audioMode = 'none') {
  const osc = await import('osc-min');
  const audio = [], udp = dgram.createSocket('udp4');
  udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
  t.after(() => udp.close());
  udp.on('message', bytes => { const message = osc.fromBuffer(bytes); audio.push({ address: message.address, values: message.args.map(arg => arg.value) }); });
  const clients = [];
  t.after(() => {
    for (const socket of clients) socket.disconnect();
  });
  const runtime = await runtimeFixture(t, {
    mode: audioMode,
    managed: true,
    environment: { PNDS_OSC_TARGET: `127.0.0.1:${udp.address().port}` },
  });
  const root = runtime.performerUrl;
  await runtime.ready();
  async function connect(userType, claimToken = 'a'.repeat(24)) {
    const socket = io(root, { reconnection: false, transports: ['websocket'] });
    clients.push(socket); await once(socket, 'connect');
    const confirm = once(socket, E.idConfirmation); socket.emit(E.selectId, { userType, claimToken });
    assert.equal((await confirm)[0].status, 'accepted');
    return socket;
  }
  async function command(body) {
    const response = await fetch(root + '/__pnds/recording', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  }
  return { command, connect, audio, root };
}

test('overdub initialization records existing membership at time zero', async () => {
  const sourceId = 'live-player';
  const adapter = createRecordingAdapter({
    adapterId: 'inarticulate-iii-v1',
    async restore() {
      await delay(20);
      adapter.selection(sourceId, null);
    },
  });
  adapter.register(sourceId, 'Performer 1', 1);
  const body = {
    action: 'begin', operationId: 'start-overdub', mode: 'overdub',
    livePassId: 'new-pass', initialState: {}, replayPerformers: [],
  };
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url: '/__pnds/recording',
    method: 'POST',
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let response;
  await adapter.handle(request, {
    setHeader() {},
    writeHead(status) { assert.fail(`Unexpected recording status ${status}`); },
    end(data) { response = JSON.parse(data); },
  });
  assert.deepEqual(response.events.map(({ kind, atMs }) => [kind, atMs]), [
    ['selection', 0],
    ['join', 0],
  ]);
});

test('III can discover recording on the managed performer listener while browsers remain excluded', async t => {
  const f = await fixture(t);
  const endpoint = f.root + '/__pnds/recording';
  const response = await fetch(endpoint);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), require('../pnds.recording.json'));
  const browser = await fetch(endpoint, { headers: { Origin: f.root } });
  assert.equal(browser.status, 403);
});

test('III records accepted touch and derived pair controls and restores both at replay', { timeout: 15000 }, async t => {
  const f = await fixture(t), op = await f.connect('0'), player = await f.connect('1');
  const points = [], controls = [];
  op.on(E.pointSend, value => points.push(value)); op.on(E.oscActivity, value => controls.push(value));
  const initial = await f.command({ action: 'begin', operationId: 'record', mode: 'record' });
  const point = { main: { x: 0.25, y: 0.4 }, relX: 0.25, relY: 0.4, amp: { length: 0.7 } };
  player.emit(E.point, point); player.emit(E.lineStroke, { id: 'p1-p2', stroke: 0.42 });
  const recorded = await until(async () => {
    const value = await f.command({ action: 'poll', operationId: 'record', afterSequence: 0 });
    return value.events.some(e => e.kind === 'stroke') ? value : null;
  });
  assert.equal(recorded.performers.length, 1); assert.equal(recorded.performers[0].selection, 1);
  const saved = await f.command({ action: 'end', operationId: 'record', release: false });
  assert.ok(!points.at(-1).clear, 'ordinary recording stop preserves live hold');
  await f.command({ action: 'begin', operationId: 'play', mode: 'playback', initialState: initial.initialState, replayPerformers: saved.performers });
  points.length = 0; controls.length = 0;
  await f.command({ action: 'drive', operationId: 'play', elapsedMs: saved.elapsedMs, events: saved.events });
  await until(() => points.some(p => p.clientId === 1 && p.main));
  await until(() => controls.some(c => c.address === '/p1-p2' && c.values[0] === 0.42));
  player.emit(E.point, []); player.emit(E.lineStroke, { id: 'p1-p2', stroke: 0.9 });
  await delay(40);
  assert.ok(!points.at(-1).clear, 'live device cannot release a replay source');
  assert.ok(!controls.some(c => c.values[0] === 0.9));
  await f.command({ action: 'end', operationId: 'play', release: true });
  await until(() => points.at(-1)?.clear);
});

test('III reuses one physical device for independent overdub performers and keeps interactive pair controls', { timeout: 15000 }, async t => {
  const f = await fixture(t), op = await f.connect('0'), player = await f.connect('1');
  const visible = new Map(), activity = [];
  op.on(E.pointSend, point => { if (point.clear) visible.delete(point.clientId); else visible.set(point.clientId, point); });
  op.on(E.oscActivity, value => activity.push(value));
  const point = value => ({ main: { x: value, y: 0.4 }, relX: value, relY: 0.4, amp: { length: 0.7 } });
  const initial = await f.command({ action: 'begin', operationId: 'first', mode: 'record' });
  player.emit(E.point, point(0.2));
  const saved = await until(async () => {
    const value = await f.command({ action: 'poll', operationId: 'first', afterSequence: 0 });
    return value.events.some(e => e.kind === 'point') ? value : null;
  });
  await f.command({ action: 'end', operationId: 'first', release: false });
  async function select(number) {
    const confirmed = once(player, E.idConfirmation); player.emit(E.selectId, { userType: String(number), claimToken: 'a'.repeat(24) });
    assert.equal((await confirmed)[0].status, 'accepted');
  }
  await f.command({ action: 'begin', operationId: 'second', mode: 'overdub', initialState: initial.initialState, replayPerformers: saved.performers, livePerformerId: 'recorded-B' });
  await select(2);
  await f.command({ action: 'drive', operationId: 'second', elapsedMs: saved.elapsedMs, events: saved.events });
  player.emit(E.point, point(0.5)); player.emit(E.lineStroke, { id: 'p2-p1', stroke: 0.63 });
  await until(() => visible.has(1) && visible.has(2) && activity.some(c => c.address === '/p2-p1' && c.values[0] === 0.63));
  const second = await f.command({ action: 'end', operationId: 'second', release: true });
  assert.deepEqual(second.performers.map(p => p.id), ['recorded-B']);
  assert.equal(second.performers[0].selection, 2);
  const offset = Math.max(...saved.events.map(event => event.sequence));
  const merged = [...saved.events, ...second.events.map(event => ({ ...event, sequence: event.sequence + offset }))].sort((a, b) => a.atMs - b.atMs || a.sequence - b.sequence);
  await f.command({ action: 'begin', operationId: 'third', mode: 'overdub', initialState: initial.initialState, replayPerformers: [...saved.performers, ...second.performers], livePerformerId: 'recorded-C' });
  await select(3);
  await f.command({ action: 'drive', operationId: 'third', elapsedMs: 1000, events: merged.filter(event => event.kind !== 'release') });
  player.emit(E.point, point(0.8)); player.emit(E.lineStroke, { id: 'p3-p2', stroke: 0.51 });
  await until(() => visible.has(1) && visible.has(2) && visible.has(3));
  const third = await f.command({ action: 'end', operationId: 'third', release: true });
  assert.deepEqual(third.performers.map(p => [p.id, p.selection]), [['recorded-C', 3]]);
  assert.ok(third.events.some(e => e.kind === 'stroke' && e.payload.id === 'p3-p2'));
});


test('III replays sequential performers who reused an exclusive selection', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'external'), op = await f.connect('0');
  const visible = [];
  op.on(E.pointSend, point => visible.push(point));
  const initial = await f.command({ action: 'begin', operationId: 'history', mode: 'record' });
  const a = await f.connect('1', 'a'.repeat(24));
  a.emit(E.point, { main: { x: 0.2, y: 0.4 }, relX: 0.2, amp: { length: 0.7 } });
  await until(async () => (await f.command({ action: 'poll', operationId: 'history', afterSequence: 0 })).events.some(e => e.kind === 'point'));
  a.disconnect();
  await until(async () => (await f.command({ action: 'poll', operationId: 'history', afterSequence: 0 })).events.some(e => e.kind === 'leave'));
  const b = await f.connect('1', 'b'.repeat(24));
  b.emit(E.point, { main: { x: 0.8, y: 0.4 }, relX: 0.8, amp: { length: 0.7 } });
  const saved = await until(async () => {
    const value = await f.command({ action: 'poll', operationId: 'history', afterSequence: 0 });
    return value.events.filter(e => e.kind === 'point').length === 2 ? value : null;
  });
  await f.command({ action: 'end', operationId: 'history', release: false });
  assert.equal(saved.performers.length, 2);
  assert.notEqual(saved.performers[0].id, saved.performers[1].id);
  await f.command({ action: 'begin', operationId: 'history-play', mode: 'playback', initialState: initial.initialState, replayPerformers: saved.performers });
  visible.length = 0;
  await f.command({ action: 'drive', operationId: 'history-play', elapsedMs: saved.elapsedMs, events: saved.events });
  await until(() => visible.some(p => p.main?.x === 0.8));
  assert.deepEqual(visible.filter(p => p.main).map(p => p.main.x), [0.2, 0.8]);
  await delay(130);
  assert.equal(f.audio.filter(event => event.address === '/p1').at(-1)?.values[0], 1, 'departed source retries never release the next source audio');
  await f.command({ action: 'end', operationId: 'history-play', release: true });
});


test('III live selection and disconnect cannot release a replay-owned audio slot', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'external'), op = await f.connect('0'), player = await f.connect('1');
  const activity = [], points = [];
  op.on(E.oscActivity, value => activity.push(value));
  op.on(E.pointSend, value => points.push(value));
  const point = x => ({ main: { x, y: 0.4 }, relX: x, amp: { length: 0.7 } });
  const initial = await f.command({ action: 'begin', operationId: 'owner-record', mode: 'record' });
  player.emit(E.point, point(0.2));
  const saved = await until(async () => {
    const value = await f.command({ action: 'poll', operationId: 'owner-record', afterSequence: 0 });
    return value.events.some(e => e.kind === 'point') ? value : null;
  });
  await f.command({ action: 'end', operationId: 'owner-record', release: false });
  async function select(number) {
    const confirmed = once(player, E.idConfirmation);
    player.emit(E.selectId, { userType: String(number), claimToken: 'a'.repeat(24) });
    assert.equal((await confirmed)[0].status, 'accepted');
  }
  await f.command({ action: 'begin', operationId: 'owner-play', mode: 'playback', initialState: initial.initialState, replayPerformers: saved.performers });
  await f.command({ action: 'drive', operationId: 'owner-play', elapsedMs: saved.elapsedMs, events: saved.events });
  await until(() => points.at(-1)?.main?.x === 0.2);
  await until(() => f.audio.filter(event => event.address === '/p1').at(-1)?.values[0] === 1);
  activity.length = 0;
  await select(0);
  await select(1);
  player.disconnect();
  await delay(130);
  assert.ok(!activity.some(event => event.address === '/p1' && event.values[0] === 0), 'a watching device never releases the replay owner');
  assert.equal(f.audio.filter(event => event.address === '/p1').at(-1)?.values[0], 1, 'operator selection/disconnect never release replay audio');
  await f.command({ action: 'end', operationId: 'owner-play', release: true });
  const current = await f.connect('1');
  await f.command({ action: 'begin', operationId: 'owner-overdub', mode: 'overdub', initialState: initial.initialState, replayPerformers: saved.performers, livePerformerId: 'new-performer' });
  await f.command({ action: 'drive', operationId: 'owner-overdub', elapsedMs: saved.elapsedMs, events: saved.events });
  activity.length = 0; points.length = 0;
  current.emit(E.point, point(0.9));
  const confirmed = once(current, E.idConfirmation);
  current.emit(E.selectId, { userType: '2', claimToken: 'a'.repeat(24) });
  assert.equal((await confirmed)[0].status, 'accepted');
  current.emit(E.point, point(0.7));
  await until(() => points.some(p => p.clientId === 2 && p.main?.x === 0.7));
  assert.ok(!points.some(p => p.clientId === 1 && p.main?.x === 0.9), 'admission alone cannot seize another source slot');
  assert.ok(!activity.some(event => event.address === '/p1' && event.values[0] === 0));
  await delay(130);
  assert.equal(f.audio.filter(event => event.address === '/p1').at(-1)?.values[0], 1, 'admitted live selection changes preserve replay audio');
  await f.command({ action: 'end', operationId: 'owner-overdub', release: true });
  await until(() => f.audio.filter(event => event.address === '/p1').at(-1)?.values[0] === 0);
});


test('III same-claim takeover disconnect cannot mark its current replacement offline', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'external'), op = await f.connect('0'), old = await f.connect('1');
  const initial = await f.command({ action: 'begin', operationId: 'takeover', mode: 'record' });
  const current = await f.connect('1');
  current.emit(E.point, { main: { x: 0.6, y: 0.4 }, relX: 0.6, amp: { length: 0.7 } });
  await until(async () => (await f.command({ action: 'poll', operationId: 'takeover', afterSequence: 0 })).events.some(e => e.kind === 'point'));
  const disconnected = once(op, E.clientCount); old.disconnect(); await disconnected;
  const saved = await f.command({ action: 'end', operationId: 'takeover', release: false });
  assert.equal(saved.events.at(-1).kind, 'point', 'displaced transport adds no leave after its replacement joined');
  await f.command({ action: 'begin', operationId: 'takeover-play', mode: 'playback', initialState: initial.initialState, replayPerformers: saved.performers });
  await f.command({ action: 'drive', operationId: 'takeover-play', elapsedMs: saved.elapsedMs, events: saved.events });
  await delay(130);
  assert.equal(f.audio.filter(event => event.address === '/p1').at(-1)?.values[0], 1);
  await f.command({ action: 'end', operationId: 'takeover-play', release: true });
});

test('III captures a multi-device pass and late joins while keeping independent replay slots', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'external'), op = await f.connect('0'), a = await f.connect('1');
  const points = [], activity = [];
  op.on(E.pointSend, value => points.push(value));
  op.on(E.oscActivity, value => activity.push(value));
  const point = x => ({ main: { x, y: 0.4 }, relX: x, relY: 0.4, amp: { length: 0.7 } });
  const initial = await f.command({ action: 'begin', operationId: 'multi-first', mode: 'record', livePassId: 'first-pass' });
  a.emit(E.point, point(0.2));
  await until(async () => (await f.command({ action: 'poll', operationId: 'multi-first', afterSequence: 0 })).events.some(e => e.kind === 'point'));
  const first = await f.command({ action: 'end', operationId: 'multi-first', release: false });
  const begin = await f.command({ action: 'begin', operationId: 'multi-second', mode: 'overdub', livePassId: 'second-pass',
    initialState: initial.initialState, replayPerformers: first.performers });
  assert.equal(begin.passId, 'second-pass');
  const confirmed = once(a, E.idConfirmation);
  a.emit(E.selectId, { userType: '2', claimToken: 'a'.repeat(24) });
  assert.equal((await confirmed)[0].status, 'accepted');
  const b = await f.connect('3', 'b'.repeat(24));
  await f.command({ action: 'drive', operationId: 'multi-second', elapsedMs: first.elapsedMs, events: first.events });
  a.emit(E.point, point(0.5)); b.emit(E.point, point(0.8));
  await until(() => points.some(p => p.clientId === 1 && p.main?.x === 0.2) && points.some(p => p.clientId === 2 && p.main?.x === 0.5) && points.some(p => p.clientId === 3 && p.main?.x === 0.8));
  await until(() => activity.some(e => e.address === '/p2') && activity.some(e => e.address === '/p3'));
  const second = await f.command({ action: 'end', operationId: 'multi-second', release: true });
  assert.equal(second.performers.length, 2);
  assert.deepEqual(second.performers.map(p => p.selection).sort(), [2, 3]);
  assert.ok(second.performers.every(p => !first.performers.some(old => old.id === p.id)));
  assert.equal(second.events.filter(e => e.kind === 'release').length, 2);
  const offset = Math.max(...first.events.map(event => event.sequence));
  const merged = [...first.events, ...second.events.map(event => ({ ...event, sequence: event.sequence + offset }))]
    .filter(event => event.kind !== 'release').sort((left, right) => left.atMs - right.atMs || left.sequence - right.sequence);
  await f.command({ action: 'begin', operationId: 'multi-full-replay', mode: 'playback', initialState: initial.initialState,
    replayPerformers: [...first.performers, ...second.performers] });
  points.length = 0;
  await f.command({ action: 'drive', operationId: 'multi-full-replay', elapsedMs: Math.max(first.elapsedMs, second.elapsedMs), events: merged });
  await until(() => points.some(p => p.clientId === 1 && p.main?.x === 0.2) && points.some(p => p.clientId === 2 && p.main?.x === 0.5) && points.some(p => p.clientId === 3 && p.main?.x === 0.8));
  await f.command({ action: 'end', operationId: 'multi-full-replay', release: true });
  await f.command({ action: 'begin', operationId: 'multi-replay', mode: 'playback', initialState: initial.initialState, replayPerformers: second.performers });
  points.length = 0;
  await f.command({ action: 'drive', operationId: 'multi-replay', elapsedMs: second.elapsedMs, events: second.events.filter(e => e.kind !== 'release') });
  await until(() => points.some(p => p.clientId === 2 && p.main?.x === 0.5) && points.some(p => p.clientId === 3 && p.main?.x === 0.8));
  assert.ok(!points.some(p => p.clientId === 1 && p.main), 'removed first-pass membership does not reappear');
  await f.command({ action: 'end', operationId: 'multi-replay', release: true });
});
