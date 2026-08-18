// Inarticulate III — work audio layer.
//
// This is the file creators edit to change the *semantics* of the work
// (what touches control, how voices are routed). The transport and engine
// primitives live in lib/.
//
// Audio architecture:
//   Internal  → one synth node (nodeId 1001) with 3 voices inside a single
//               SynthDef. Gate, x/y, amp controls go through /n_set.
//   External  → sends the work's own OSC protocol (/p1, /p1xy, /p1-p2 etc.)
//   None      → no-op
//
// The single-synth design (vs. per-voice synths) is intentional: the three
// voices cross-modulate each other via FM feedback (LocalIn/LocalOut).

const { AudioEngine } = require("../lib/audio-engine");
const { oscFloat } = require("../lib/osc-transport");

const VALID_PLAYERS = new Set([1, 2, 3]);
const SYNTH_NAME = "inarticulate-iii";
const GROUP_ID = 1000;
const SYNTH_NODE_ID = GROUP_ID + 1;
const ROOT_GROUP_ID = 0;

const PAIR_CONTROLS = {
  "1-2": "couple12",
  "1-3": "couple13",
  "2-3": "couple23",
};

function clamp01(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, Math.min(1, number));
}

function playerNumber(player) {
  const number = Number(player);

  if (!Number.isInteger(number) || !VALID_PLAYERS.has(number)) {
    throw new Error(`Invalid player number: ${player}`);
  }

  return number;
}

function parsePair(pair) {
  const value = String(pair || "").trim();
  const match = /^p?([123])-p?([123])$/.exec(value);

  if (!match || match[1] === match[2]) {
    throw new Error(
      `Invalid player pair '${pair}'. Expected p1-p2, p1-p3, or p2-p3.`,
    );
  }

  const first = Number(match[1]);
  const second = Number(match[2]);
  const sorted = [first, second].sort((a, b) => a - b);
  const key = `${sorted[0]}-${sorted[1]}`;

  return {
    first,
    second,
    key,
    externalAddress: `/p${first}-p${second}`,
    internalControl: PAIR_CONTROLS[key],
  };
}

class ProjectAudio {
  constructor(engine) {
    if (!(engine instanceof AudioEngine)) {
      throw new Error("ProjectAudio requires an AudioEngine instance.");
    }

    this.engine = engine;
  }

  get mode() {
    return this.engine.mode;
  }

  async start() {
    await this.engine.start();

    if (this.engine.mode === "internal") {
      // Project-owned group created before health reports ready.
      await this.engine.createGroup(GROUP_ID);

      await this.engine.createSynth({
        name: SYNTH_NAME,
        nodeId: SYNTH_NODE_ID,
        groupId: GROUP_ID,
        out: this.engine.outputBus,
        controls: { master: 0.25 },
      });

      // Verify the synth node is alive by reading a known control.
      await this.engine.verifySynthControl(SYNTH_NODE_ID, "master");
    }
  }

  async setPlayerGate(player, value) {
    const id = playerNumber(player);
    const gate = clamp01(value);

    await this.engine.start();

    if (this.engine.mode === "none") {
      return;
    }

    if (this.engine.mode === "internal") {
      await this.engine.setControls(SYNTH_NODE_ID, {
        [`gate${id}`]: gate,
      });
      return;
    }

    await this.engine.send(`/p${id}`, oscFloat(gate));
  }

  async setPlayerPosition(player, { x, y, amp = 0 }) {
    const id = playerNumber(player);
    const xValue = clamp01(x);
    const yValue = clamp01(y);
    const ampValue = clamp01(amp);

    await this.engine.start();

    if (this.engine.mode === "none") {
      return;
    }

    if (this.engine.mode === "internal") {
      await this.engine.setControls(SYNTH_NODE_ID, {
        [`x${id}`]: xValue,
        [`y${id}`]: yValue,
        [`amp${id}`]: ampValue,
      });
      return;
    }

    await this.engine.send(
      `/p${id}xy`,
      oscFloat(xValue),
      oscFloat(yValue),
      oscFloat(ampValue),
    );
  }

  async setPairStroke(pair, value) {
    const parsedPair = parsePair(pair);
    const stroke = clamp01(value);

    await this.engine.start();

    if (this.engine.mode === "none") {
      return;
    }

    if (this.engine.mode === "internal") {
      await this.engine.setControls(SYNTH_NODE_ID, {
        [parsedPair.internalControl]: stroke,
      });
      return;
    }

    await this.engine.send(parsedPair.externalAddress, oscFloat(stroke));
  }

  async releasePlayer(player) {
    const id = playerNumber(player);

    await this.setPlayerGate(id, 0);
  }

  async stop() {
    if (this.engine.mode === "internal" && this.engine.started) {
      await this.engine.setControls(SYNTH_NODE_ID, {
        gate1: 0,
        gate2: 0,
        gate3: 0,
      });

      await this.engine.freeNode(SYNTH_NODE_ID);
      await this.engine.freeNode(GROUP_ID);
    }

    await this.engine.stop();
  }
}

module.exports = {
  ProjectAudio,
  clamp01,
  parsePair,
};
