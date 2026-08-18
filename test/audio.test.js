const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  AudioEngine,
  resolveOutputBus,
  resolveOutputChannels,
} = require("../lib/audio-engine");
const { oscFloat } = require("../lib/osc-transport");

test("resolveOutputBus honours the PNDS contract", () => {
  assert.equal(resolveOutputBus({}), 0);
  assert.equal(resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "" }), 0);
  assert.equal(resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "2" }), 2);

  assert.throws(() => resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "-1" }));
  assert.throws(() => resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "left" }));
});

test("resolveOutputChannels falls back to manifest, then to 2", () => {
  assert.equal(
    resolveOutputChannels({}, { audio: { outputChannels: 2 } }),
    2,
  );
  assert.equal(resolveOutputChannels({}, {}), 2);
  assert.equal(resolveOutputChannels({ PNDS_AUDIO_OUTPUT_CHANNELS: "8" }, {}), 8);

  assert.throws(() =>
    resolveOutputChannels({ PNDS_AUDIO_OUTPUT_CHANNELS: "0" }, {}),
  );
  assert.throws(() =>
    resolveOutputChannels({ PNDS_AUDIO_OUTPUT_CHANNELS: "65" }, {}),
  );
});

// ------------------------------------------------------------
// Engine commands through an injected (recording) transport — no
// scsynth, no UDP; asserts the boot sequence and scsynth encoding.
// ------------------------------------------------------------

class FakeTransport {
  constructor() {
    this.sent = [];
    this.closed = false;
    this.nextSyncId = 1;
  }

  async start() {}

  async send(address, ...args) {
    this.sent.push({ address, args });
  }

  // The request-style helpers go through send(), like the real transport.
  async status() {
    await this.send("/status");
    return { address: "/status.reply" };
  }

  async loadSynthDef(filePath) {
    await this.send("/d_load", filePath);
    return { address: "/done" };
  }

  async sync() {
    const syncId = this.nextSyncId;
    this.nextSyncId += 1;
    await this.send("/sync", { type: "integer", value: syncId });
    return { address: "/synced" };
  }

  async getSynthControl(nodeId, control) {
    await this.send(
      "/s_get",
      { type: "integer", value: nodeId },
      control,
    );
    return { address: "/n_set", args: [{ value: control }] };
  }

  async close() {
    this.closed = true;
  }
}

function plain(argument) {
  return argument && argument.value !== undefined ? argument.value : argument;
}

function createEngine({ mode = "internal" } = {}) {
  const transport = new FakeTransport();
  const engine = new AudioEngine({
    mode,
    target: "127.0.0.1:57110",
    projectRoot: path.join(__dirname, ".."),
    manifest: {
      audio: {
        synthdefs: ["supercollider/synthdefs/inarticulate-iii.scsyndef"],
      },
    },
    environment: {},
    transportFactory: () => transport,
  });

  return { engine, transport };
}

test("internal boot pings status, loads each synthdef, then syncs", async () => {
  const { engine, transport } = createEngine();

  await engine.start();

  assert.deepEqual(
    transport.sent.map((m) => m.address),
    ["/status", "/d_load", "/sync"],
  );
  assert.equal(
    transport.sent[1].args[0],
    path.join(
      __dirname,
      "..",
      "supercollider/synthdefs/inarticulate-iii.scsyndef",
    ),
  );
});

test("engine commands encode the scsynth argument order", async () => {
  const { engine, transport } = createEngine();

  await engine.createGroup(1000);
  await engine.createSynth({
    name: "inarticulate-iii",
    nodeId: 1001,
    groupId: 1000,
    out: 2,
    controls: { master: 0.25 },
  });
  await engine.setControls(1001, { gate1: 1 });
  await engine.freeNode(1001);

  assert.deepEqual(
    transport.sent.map((m) => [m.address, ...m.args.map(plain)]),
    [
      ["/status"],
      [
        "/d_load",
        path.join(
          __dirname,
          "..",
          "supercollider/synthdefs/inarticulate-iii.scsyndef",
        ),
      ],
      ["/sync", 1],
      ["/g_new", 1000, 1, 0],
      [
        "/s_new",
        "inarticulate-iii",
        1001,
        1,
        1000,
        "out",
        2,
        "master",
        0.25,
      ],
      ["/n_set", 1001, "gate1", 1],
      ["/n_free", 1001],
    ],
  );
});

test("verifySynthControl reads the control back via /s_get", async () => {
  const { engine, transport } = createEngine();

  await engine.start();
  const reply = await engine.verifySynthControl(1001, "master");

  assert.deepEqual(
    transport.sent.at(-1).args.map(plain),
    [1001, "master"],
  );
  assert.equal(reply.args[0].value, "master");
});

test("engine commands after stop() are no-ops (shutdown race)", async () => {
  const { engine } = createEngine({ mode: "none" });

  await engine.start();
  await engine.stop();

  // Late releases from disconnect handlers arrive while the transport is
  // already closed — they must not throw.
  await engine.freeNode(1001);
  await engine.setControls(1001, { gate1: 0 });
  await engine.send("/p1", [oscFloat(0)]);
  await engine.verifySynthControl(1001, "master");
});

test("stop() closes the injected transport", async () => {
  const { engine, transport } = createEngine();

  await engine.start();
  await engine.stop();

  assert.equal(transport.closed, true);
});

test("external send passes the work OSC message through as one array", async () => {
  const { engine, transport } = createEngine({ mode: "external" });

  await engine.start();
  await engine.send("/p1xy", [oscFloat(0.5), oscFloat(0.25), oscFloat(0.75)]);
  await engine.stop(); // leave no transport (socket) behind

  assert.deepEqual(transport.sent, [
    {
      address: "/p1xy",
      args: [
        { type: "float", value: 0.5 },
        { type: "float", value: 0.25 },
        { type: "float", value: 0.75 },
      ],
    },
  ]);
});
