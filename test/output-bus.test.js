const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveOutputBus,
} = require("../audio/audio-controller");

// PNDS App 注入 PNDS_AUDIO_OUTPUT_BUS，指向一条 private stereo bus。
// 手动 standalone 运行时该变量不存在，必须回退到硬件 bus 0，
// 否则声音会被写进一条没有人读取的总线，表现为“启动成功但没声音”。
test("resolveOutputBus", () => {
  assert.equal(resolveOutputBus({}), 0);
  assert.equal(resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "" }), 0);
  assert.equal(resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "2" }), 2);

  assert.throws(
    () => resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "-1" }),
  );

  assert.throws(
    () => resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "left" }),
  );
});
