// ProjectAudio contract tests against a fake engine — no AudioEngine
// class, no UDP. The fake records every engine write, so tests assert
// the exact internal/external encoding of the work's three controls
// (gate, position, pair stroke).

const { test } = require("node:test");
const assert = require("node:assert");

const { ProjectAudio } = require("../audio/controller");

class FakeEngine {
  constructor({ mode = "internal", outputBus = 0 } = {}) {
    this.mode = mode;
    this.outputBus = outputBus;
    this.outputChannels = 2;
    this.createGroupCalls = [];
    this.createSynthCalls = [];
    this.setControlsCalls = [];
    this.freedNodes = [];
    this.sent = [];
    this.verified = [];
    this.started = false;
  }

  async start() {
    this.started = true;
  }

  async createGroup(groupId) {
    this.createGroupCalls.push(groupId);
  }

  async createSynth(args) {
    this.createSynthCalls.push(args);
  }

  async setControls(nodeId, controls) {
    this.setControlsCalls.push({ nodeId, controls });
  }

  async freeNode(nodeId) {
    this.freedNodes.push(nodeId);
  }

  async send(address, args) {
    this.sent.push({ address, args });
  }

  async verifySynthControl(nodeId, control) {
    this.verified.push({ nodeId, control });
  }

  async stop() {}
}

test("ProjectAudio accepts any engine satisfying the engine interface", () => {
  // Regression: the constructor once required engine instanceof AudioEngine,
  // which blocked substitute engines (and forced tests through real UDP).
  assert.doesNotThrow(() => new ProjectAudio(new FakeEngine()));
});

test("internal start creates group + synth, then verifies the node", async () => {
  const engine = new FakeEngine({ outputBus: 2 });
  const audio = new ProjectAudio(engine);

  await audio.start();

  assert.deepEqual(engine.createGroupCalls, [1000]);
  assert.deepEqual(engine.createSynthCalls, [
    {
      name: "inarticulate-iii",
      nodeId: 1001,
      groupId: 1000,
      out: 2,
      controls: { master: 0.25 },
    },
  ]);
  assert.deepEqual(engine.verified, [{ nodeId: 1001, control: "master" }]);
});

test("setPlayerGate maps to gate<N> internally and /pN externally", async () => {
  const internal = new ProjectAudio(new FakeEngine());
  await internal.setPlayerGate(1, 1);
  await internal.setPlayerGate("2", 0.5);

  assert.deepEqual(internal.engine.setControlsCalls, [
    { nodeId: 1001, controls: { gate1: 1 } },
    { nodeId: 1001, controls: { gate2: 0.5 } },
  ]);

  const external = new ProjectAudio(new FakeEngine({ mode: "external" }));
  await external.setPlayerGate(3, 1);

  assert.deepEqual(external.engine.sent, [
    { address: "/p3", args: [{ type: "float", value: 1 }] },
  ]);
});

test("setPlayerPosition maps to x/y/amp<N> internally and /pNxy externally", async () => {
  const internal = new ProjectAudio(new FakeEngine());
  await internal.setPlayerPosition(2, { x: 0.25, y: 0.75, amp: 0.5 });

  assert.deepEqual(internal.engine.setControlsCalls, [
    { nodeId: 1001, controls: { x2: 0.25, y2: 0.75, amp2: 0.5 } },
  ]);

  const external = new ProjectAudio(new FakeEngine({ mode: "external" }));
  await external.setPlayerPosition(2, { x: 0.25, y: 0.75, amp: 0.5 });

  assert.deepEqual(external.engine.sent, [
    {
      address: "/p2xy",
      args: [
        { type: "float", value: 0.25 },
        { type: "float", value: 0.75 },
        { type: "float", value: 0.5 },
      ],
    },
  ]);
});

test("setPairStroke sorts the pair and maps to couple controls", async () => {
  const internal = new ProjectAudio(new FakeEngine());
  await internal.setPairStroke("p2-p1", 0.5);

  assert.deepEqual(internal.engine.setControlsCalls, [
    { nodeId: 1001, controls: { couple12: 0.5 } },
  ]);

  const external = new ProjectAudio(new FakeEngine({ mode: "external" }));
  await external.setPairStroke("2-3", 0.5);

  assert.deepEqual(external.engine.sent, [
    { address: "/p2-p3", args: [{ type: "float", value: 0.5 }] },
  ]);

  await assert.rejects(() => internal.setPairStroke("p1-p1", 0.5));
  await assert.rejects(() => internal.setPairStroke("nope", 0.5));
});

test("none mode touches no transport", async () => {
  const audio = new ProjectAudio(new FakeEngine({ mode: "none" }));

  await audio.setPlayerGate(1, 1);
  await audio.setPlayerPosition(1, { x: 0.5, y: 0.5, amp: 0.5 });
  await audio.setPairStroke("1-2", 0.5);

  assert.deepEqual(audio.engine.setControlsCalls, []);
  assert.deepEqual(audio.engine.sent, []);
});

test("stop() silences gates, then frees synth and group", async () => {
  const engine = new FakeEngine();
  const audio = new ProjectAudio(engine);

  await audio.start(); // stop() only tears down a started engine
  await audio.stop();

  assert.deepEqual(engine.setControlsCalls, [
    { nodeId: 1001, controls: { gate1: 0, gate2: 0, gate3: 0 } },
  ]);
  assert.deepEqual(engine.freedNodes, [1001, 1000]);
});
