// Independent OSC 1.0 wire literals: no OSC decoder/encoder in the assertions.
const test = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { once } = require("node:events");
const { OscTransport } = require("../lib/osc-transport");
const { AudioEngine } = require("../lib/audio-engine");
const { ProjectAudio } = require("../audio/controller");

async function receiver(t) {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  t.after(() => new Promise(resolve => socket.close(resolve)));
  return socket;
}

test("External OSC preserves the work's p2xy float wire encoding with osc-min 2", { timeout: 3000 }, async t => {
  const socket = await receiver(t);
  const engine = new AudioEngine({
    mode: "external", target: `127.0.0.1:${socket.address().port}`,
    projectRoot: __dirname, manifest: {}, environment: {},
  });
  const audio = new ProjectAudio(engine);
  t.after(() => audio.stop());
  await audio.start();
  const incoming = once(socket, "message");
  await audio.setPlayerPosition(2, { x: 0.25, y: 0.75, amp: 0.5 });
  const [packet] = await incoming;
  assert.equal(packet.toString("hex"), "2f703278790000002c666666000000003e8000003f4000003f000000");
});

test("OSC sync sends an integer and reads a UDP reply from its exact buffer slice", { timeout: 3000 }, async t => {
  const socket = await receiver(t);
  const transport = new OscTransport({ target: `127.0.0.1:${socket.address().port}` });
  t.after(() => transport.close());
  await transport.start();
  const incoming = once(socket, "message");
  const synced = transport.sync();
  synced.catch(() => {}); // keep a failed wire assertion from leaving an unhandled reply waiter
  const [packet, remote] = await incoming;
  assert.equal(packet.toString("hex"), "2f73796e630000002c69000000000001");
  socket.send(Buffer.from("2f73796e636564002c69000000000001", "hex"), remote.port, remote.address);
  const reply = await synced;
  assert.equal(reply.address, "/synced");
  assert.equal(reply.args[0].value, 1);
});
