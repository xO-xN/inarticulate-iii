const fs = require("node:fs");
const path = require("node:path");
const {
  OscController,
  oscFloat,
  oscInteger,
} = require("./osc-controller");

const VALID_MODES = new Set(["internal", "external", "none"]);
const VALID_PLAYERS = new Set([1, 2, 3]);

const PAIR_CONTROLS = {
  "1-2": "couple12",
  "1-3": "couple13",
  "2-3": "couple23",
};

const DEFAULT_SYNTH_NAME = "inarticulateIII";
const ROOT_GROUP_ID = 0;
const DEFAULT_GROUP_ID = 1000;
const STANDALONE_OUTPUT_BUS = 0;

// PNDS V1 Internal audio contract:
// PNDS App 分配一条 private stereo bus，并注入 PNDS_AUDIO_OUTPUT_BUS。
// App 自己的 master synth 从该 bus 读取、控制总音量后输出到硬件 bus 0/1。
// 手动 standalone 运行时没有 App master stage，直接输出到硬件 bus 0。
function resolveOutputBus(environment) {
  const rawBus = environment.PNDS_AUDIO_OUTPUT_BUS;

  if (rawBus === undefined || String(rawBus).trim() === "") {
    return STANDALONE_OUTPUT_BUS;
  }

  const bus = Number(rawBus);

  if (!Number.isInteger(bus) || bus < 0) {
    throw new Error(
      `Invalid PNDS_AUDIO_OUTPUT_BUS '${rawBus}': expected a non-negative integer.`,
    );
  }

  return bus;
}

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

function resolveSynthDefPaths(projectRoot, manifest) {
  const entries = manifest.audio?.synthdefs;

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      "Internal Synth mode requires audio.synthdefs in manifest.json.",
    );
  }

  return entries.map((entry) => {
    const filePath = path.resolve(projectRoot, entry);

    if (!fs.existsSync(filePath)) {
      throw new Error(`SynthDef file does not exist: ${filePath}`);
    }

    return filePath;
  });
}

class AudioController {
  constructor({
    mode,
    target,
    projectRoot,
    manifest,
    environment = process.env,
  }) {
    if (!VALID_MODES.has(mode)) {
      throw new Error(`Unsupported audio mode: ${mode}`);
    }

    this.mode = mode;
    this.target = target;
    this.projectRoot = projectRoot;
    this.manifest = manifest;
    this.osc = null;
    this.started = false;
    this.startPromise = null;
    this.groupId = DEFAULT_GROUP_ID;
    this.synthNodeId = DEFAULT_GROUP_ID + 1;
    this.outputBus = resolveOutputBus(environment);
    this.synthName =
      manifest.audio?.synthName || DEFAULT_SYNTH_NAME;
  }

  start() {
    if (!this.startPromise) {
      this.startPromise = this.startInternal();
    }

    return this.startPromise;
  }

  async startInternal() {
    if (this.mode === "none") {
      this.started = true;
      return;
    }

    this.osc = new OscController({
      target: this.target,
    });

    try {
      await this.osc.start();

      if (this.mode === "external") {
        this.started = true;
        return;
      }

      const synthDefPaths = resolveSynthDefPaths(
        this.projectRoot,
        this.manifest,
      );

      await this.osc.status();

      for (const synthDefPath of synthDefPaths) {
        await this.osc.loadSynthDef(synthDefPath);
      }

      await this.osc.sync();
      await this.createInternalSynth();
      await this.osc.sync();

      this.started = true;
    } catch (error) {
      await this.osc.close().catch(() => undefined);
      this.osc = null;
      throw error;
    }
  }

  async createInternalSynth() {
    await this.osc.send(
      "/g_new",
      oscInteger(this.groupId),
      oscInteger(1),
      // Bare scsynth exposes only root group 0. Group 1 is created by sclang.
      oscInteger(ROOT_GROUP_ID),
    );

    await this.osc.send(
      "/s_new",
      this.synthName,
      oscInteger(this.synthNodeId),
      oscInteger(1),
      oscInteger(this.groupId),
      "out",
      oscInteger(this.outputBus),
      "master",
      oscFloat(0.25),
    );

    await this.osc.getSynthControl(
      this.synthNodeId,
      "master",
    );
  }

  async setPlayerGate(player, value) {
    const id = playerNumber(player);
    const gate = clamp01(value);

    await this.start();

    if (this.mode === "none") {
      return;
    }

    if (this.mode === "internal") {
      await this.osc.send(
        "/n_set",
        oscInteger(this.synthNodeId),
        `gate${id}`,
        oscFloat(gate),
      );
      return;
    }

    await this.osc.send(`/p${id}`, oscFloat(gate));
  }

  async setPlayerPosition(player, { x, y, amp = 0 }) {
    const id = playerNumber(player);
    const xValue = clamp01(x);
    const yValue = clamp01(y);
    const ampValue = clamp01(amp);

    await this.start();

    if (this.mode === "none") {
      return;
    }

    if (this.mode === "internal") {
      await this.osc.send(
        "/n_set",
        oscInteger(this.synthNodeId),
        `x${id}`,
        oscFloat(xValue),
        `y${id}`,
        oscFloat(yValue),
        `amp${id}`,
        oscFloat(ampValue),
      );
      return;
    }

    await this.osc.send(
      `/p${id}xy`,
      oscFloat(xValue),
      oscFloat(yValue),
      oscFloat(ampValue),
    );
  }

  async setPairStroke(pair, value) {
    const parsedPair = parsePair(pair);
    const stroke = clamp01(value);

    await this.start();

    if (this.mode === "none") {
      return;
    }

    if (this.mode === "internal") {
      await this.osc.send(
        "/n_set",
        oscInteger(this.synthNodeId),
        parsedPair.internalControl,
        oscFloat(stroke),
      );
      return;
    }

    await this.osc.send(
      parsedPair.externalAddress,
      oscFloat(stroke),
    );
  }

  async releasePlayer(player) {
    const id = playerNumber(player);

    await this.setPlayerGate(id, 0);
  }

  async stop() {
    if (this.mode === "none") {
      this.started = false;
      return;
    }

    if (!this.osc) {
      this.started = false;
      return;
    }

    if (this.mode === "internal" && this.started) {
      await this.osc.send(
        "/n_set",
        oscInteger(this.synthNodeId),
        "gate1",
        oscFloat(0),
        "gate2",
        oscFloat(0),
        "gate3",
        oscFloat(0),
      );

      await this.osc.send(
        "/n_free",
        oscInteger(this.synthNodeId),
      );

      await this.osc.send(
        "/n_free",
        oscInteger(this.groupId),
      );

      await this.osc.sync();
    }

    await this.osc.close();
    this.osc = null;
    this.started = false;
  }
}

module.exports = {
  AudioController,
  clamp01,
  parsePair,
  resolveOutputBus,
};
