const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveOutputBus,
  resolveOutputChannels,
} = require("../lib/audio-engine");

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
