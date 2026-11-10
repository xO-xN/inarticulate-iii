const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { runtimeFixture } = require("./support/runtime.cjs");

test("a managed run takes both inherited listeners and reports their actual health identity", { timeout: 6000 }, async t => {
  const fixture = await runtimeFixture(t, { managed: true });
  for (let attempt = 0; attempt < 80 && !fs.existsSync(fixture.assignment.reportPath); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(fs.existsSync(fixture.assignment.reportPath), "both inherited listeners publish a bound report");
  const health = await fixture.ready();
  assert.equal(health.audio.status, "disabled");
  assert.equal(health.audio.target, null);
  assert.deepEqual(health.scoreServer, {
    performerPort: fixture.performerPort,
    monitorPort: fixture.monitorPort,
    runtimeRunId: "managed-iii-test",
  });
  const report = JSON.parse(fs.readFileSync(fixture.assignment.reportPath, "utf8"));
  assert.deepEqual(report, {
    version: 1, runId: "managed-iii-test", status: "bound",
    services: [
      { role: "performer", port: fixture.performerPort },
      { role: "monitor", port: fixture.monitorPort },
    ],
  });
  const config = await (await fetch(`${fixture.monitorUrl}/__config.js?runtime=dynamic`)).text();
  assert.ok(config.includes(`"performerPort":${fixture.performerPort}`));
  assert.ok(config.includes(`"monitorPort":${fixture.monitorPort}`));
});

const path = require("node:path");
const vm = require("node:vm");
const { PROJECT_ROOT } = require("./support/runtime.cjs");
const shared = require("../public/shared.js");

function browserPage({ basePath = "/__pnds/run/first/", hostId = "host-a", role = "performer", styleReady = true, imageFailure = false, saved = new Map() } = {}) {
  const handlers = new Map();
  const sent = [];
  const resources = [];
  const reports = [];
  const failures = [];
  const nodes = new Map();
  const windowEvents = new Map();
  const touchEvents = new Map();
  const canvas = {
    addEventListener: (type, callback, options) => touchEvents.set(type, { callback, options }),
    getBoundingClientRect: () => ({ left: 20, top: 30, width: 400, height: 300 }),
  };
  nodes.set("pnds-required-style", { dataset: styleReady ? { ready: "true" } : {} });
  let connection;
  const socket = { connected: true, on: (event, callback) => handlers.set(event, callback),
    emit: (...message) => sent.push(message), volatile: { emit: (...message) => sent.push(message) }, io: { on() {} } };
  const participation = {
    basePath, socketOptions: { path: `${basePath}socket.io/` },
    resource: relative => new URL(relative, `http://score.test${basePath}`).href,
    storageKey: key => `pnds:${hostId}:inarticulate-iii:${key}`,
    reportPrepared: () => reports.push("prepared"),
    reportPreparationFailed: () => failures.push("failed"),
  };
  const context = { PNDS: shared, PNDS_PARTICIPATION: participation,
    __PNDS_CONFIG__: { role },
    location: { origin: "http://score.test", hostname: "score.test", search: "" },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    crypto: { randomUUID: () => "new-device-claim" },
    document: { body: { classList: { add() {} } }, getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, { addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } });
      return nodes.get(id);
    } },
    console: { error() {} }, URLSearchParams, Uint32Array, windowWidth: 800, windowHeight: 600,
    createCanvas: () => ({ elt: canvas }), frameRate() {}, scrollTo() {}, noLoop() {},
    loadImage: resource => { resources.push(resource); return imageFailure ? Promise.reject(new Error("missing score")) : Promise.resolve({ width: 300 }); },
    io: { connect: (origin, options) => { connection = { origin, options }; return socket; } },
    setTimeout: () => 1, clearTimeout() {}, alert() {},
    Event: class { constructor(type) { this.type = type; } },
    addEventListener: (type, callback) => windowEvents.set(type, callback),
    dispatchEvent: event => windowEvents.get(event.type)?.(),
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(PROJECT_ROOT, "public/sketch.js"), "utf8"), context);
  return { context, nodes, windowEvents, touchEvents, touch: (type, touches) => {
    let prevented = false;
    const listener = touchEvents.get(type);
    assert.ok(listener, `the actual canvas owns ${type}`);
    listener.callback({ touches, cancelable: true, preventDefault: () => { prevented = true; } });
    return { prevented, options: listener.options };
  }, styleEvent: type => {
    const html = fs.readFileSync(path.join(PROJECT_ROOT, "public/index.html"), "utf8");
    const link = html.match(/<link[^>]+id="pnds-required-style"[^>]*>/)?.[0];
    const handler = link?.match(new RegExp(`on${type}="([^"]+)"`))?.[1];
    assert.ok(handler, `required stylesheet has a ${type} event handler`);
    vm.runInNewContext(`(function () { ${handler} }).call(document.getElementById("pnds-required-style"))`, context);
  }, setup: () => context.setup(), handlers, sent, resources, reports, failures, saved, participation, connection: () => connection };
}

test("native canvas TouchEvents drive the existing two-finger point path and suppress selection", async () => {
  const page = browserPage();
  Object.assign(page.context, {
    width: 800, height: 600, touches: [], CENTER: "center",
    background() {}, noFill() {}, stroke() {}, strokeWeight() {}, circle() {}, image() {},
    fill() {}, noStroke() {}, imageMode() {}, color: () => ({ setAlpha() {} }),
    createVector: (x, y) => ({ x, y }),
    p5: { Vector: { dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) } },
    map: (value, low, high, start, end) => start + (value - low) / (high - low) * (end - start),
    constrain: (value, low, high) => Math.min(high, Math.max(low, value)),
  });
  await page.setup();
  page.handlers.get("idConfirmation")({ status: "accepted", userType: "1" });
  page.context.touches = [{ x: 400, y: 300 }];
  page.windowEvents.get("blur")();
  page.context.draw();
  page.context.draw();
  assert.deepEqual(JSON.parse(JSON.stringify(page.sent.at(-1)[1].main)), { x: 0, y: 0 }, "pointer-only pages retain the p5 input path after blur");
  page.sent.length = 0;
  const started = page.touch("touchstart", [
    { identifier: 7, clientX: 120, clientY: 105 },
    { identifier: 9, clientX: 320, clientY: 255 },
  ]);
  assert.equal(started.prevented, true);
  assert.equal(started.options.passive, false);
  page.context.draw();
  page.context.draw();
  const points = page.sent.filter(([event]) => event === "point");
  assert.equal(points.length, 1, "one actual draw path consumes native and pointer input");
  const point = JSON.parse(JSON.stringify(points[0][1]));
  assert.deepEqual(point.main, { x: -200, y: -150 });
  assert.deepEqual({ x: point.amp.x, y: point.amp.y }, { x: 200, y: 150 });
  assert.equal(point.relX, 0.25);
  assert.equal(point.relY, 0.75);
  assert.ok(point.amp.length > 0);

  page.touch("touchmove", [{ identifier: 7, clientX: 220, clientY: 180 }]);
  page.context.draw();
  page.context.draw();
  assert.deepEqual(JSON.parse(JSON.stringify(page.sent.at(-1)[1].main)), { x: 0, y: 0 });
  assert.equal(page.sent.at(-1)[1].amp, undefined, "lifting the second finger removes its amplitude input");

  page.context.touches = [{ x: 1, y: 2 }];
  assert.equal(page.touch("touchcancel", []).prevented, true);
  page.context.draw();
  assert.deepEqual(JSON.parse(JSON.stringify(page.sent.at(-1))), ["point", []], "cancel cannot revive stale p5 pointers");
  page.touchEvents.get("pointerdown")?.callback({ pointerType: "touch" });
  page.context.touches = [{ x: 600, y: 450 }];
  page.context.draw();
  page.context.draw();
  assert.deepEqual(JSON.parse(JSON.stringify(page.sent.at(-1)))[1].main, { x: 200, y: 150 }, "a later pointer-only gesture is not hidden by an old native cancellation");
  page.touch("touchstart", [{ identifier: 12, clientX: 120, clientY: 105 }]);
  page.context.draw();
  page.windowEvents.get("blur")();
  page.context.draw();
  assert.deepEqual(JSON.parse(JSON.stringify(page.sent.at(-1))), ["point", []], "leaving the page releases the held point");
});

test("confirmed page prepares its scoped score resources and restores only its Host/project claim", async () => {
  const saved = new Map([
    ["inarticulate-iii.player-id", "3"],
    ["pnds:host-a:inarticulate-iii:inarticulate-iii.player-id", "2"],
    ["pnds:host-a:inarticulate-iii:inarticulate-iii.player-claim", "saved-player-two"],
  ]);
  const page = browserPage({ saved });
  await page.setup();
  assert.deepEqual(page.resources, [
    "http://score.test/__pnds/run/first/assets/p1curve.png",
    "http://score.test/__pnds/run/first/assets/p2curve.png",
    "http://score.test/__pnds/run/first/assets/p3curve.png",
  ]);
  assert.equal(page.connection().origin, "http://score.test");
  assert.equal(page.connection().options.path, "/__pnds/run/first/socket.io/");
  assert.notEqual(page.connection().options, page.participation.socketOptions);
  assert.deepEqual(page.reports, []);
  page.handlers.get("connect")();
  assert.deepEqual(page.reports, ["prepared"]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.sent)), [["selectId", { userType: "2", claimToken: "saved-player-two" }]]);
  page.handlers.get("rolesReset")();
  assert.equal(saved.has("pnds:host-a:inarticulate-iii:inarticulate-iii.player-id"), false);
  assert.equal(saved.get("inarticulate-iii.player-id"), "3");
});

test("a required curve failure rejects preparation before any control transport opens", async () => {
  const page = browserPage({ imageFailure: true });
  await page.setup();
  assert.deepEqual(page.failures, ["failed"]);
  assert.deepEqual(page.reports, []);
  assert.equal(page.connection(), undefined);
  assert.equal(page.handlers.size, 0);
});


test("native private pages retain their original claim keys and honour credential rejection", async () => {
  const saved = new Map([
    ["inarticulate-iii.player-id", "1"],
    ["inarticulate-iii.player-claim", "original-native-claim"],
    ["pnds:host-a:inarticulate-iii:inarticulate-iii.player-id", "2"],
  ]);
  const page = browserPage({ basePath: "/", saved });
  await page.setup();
  page.handlers.get("connect")();
  assert.deepEqual(JSON.parse(JSON.stringify(page.sent)), [["selectId", { userType: "1", claimToken: "original-native-claim" }]]);
  page.handlers.get("idConfirmation")({ status: "rejected", userType: "1" });
  assert.equal(saved.has("inarticulate-iii.player-id"), false);
  assert.equal(saved.get("pnds:host-a:inarticulate-iii:inarticulate-iii.player-id"), "2");
});

test("a fresh authorization restores the same browser identity while a different Host starts independently", async () => {
  const saved = new Map([
    ["pnds:host-a:inarticulate-iii:inarticulate-iii.player-id", "2"],
    ["pnds:host-a:inarticulate-iii:inarticulate-iii.player-claim", "same-project-claim"],
  ]);
  const restarted = browserPage({ basePath: "/__pnds/run/restarted/", saved });
  await restarted.setup();
  restarted.handlers.get("connect")();
  assert.deepEqual(JSON.parse(JSON.stringify(restarted.sent)), [["selectId", { userType: "2", claimToken: "same-project-claim" }]]);
  assert.equal(restarted.connection().options.path, "/__pnds/run/restarted/socket.io/");
  const differentHost = browserPage({ hostId: "host-b", saved });
  await differentHost.setup();
  differentHost.handlers.get("connect")();
  assert.deepEqual(differentHost.sent, []);
  assert.equal(saved.get("pnds:host-b:inarticulate-iii:inarticulate-iii.player-claim"), "new-device-claim");
});

test("the monitor connects to the actual performer port without a removed QR dependency", async () => {
  const page = browserPage({ basePath: "/", role: "monitor" });
  await page.setup();
  assert.equal(page.connection().origin, "http://score.test:6868");
  assert.doesNotThrow(() => page.handlers.get("connect")());
});

test("ordinary direct pages keep a harmless context fallback and portable queried resource URLs", async t => {
  const fixture = await runtimeFixture(t, { managed: true });
  await fixture.ready();
  const fallback = await fetch(`${fixture.performerUrl}/__pnds/context.js?standalone=1`);
  assert.equal(fallback.status, 200);
  const direct = { window: {} };
  vm.runInNewContext(await fallback.text(), direct);
  assert.equal(direct.window.PNDS_PARTICIPATION, undefined);
  const html = await (await fetch(`${fixture.performerUrl}/?source=browser`)).text();
  const confirmedBase = "http://host.test/__pnds/run/confirmed/";
  for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const scoped = new URL(reference, confirmedBase);
    assert.ok(scoped.href.startsWith(confirmedBase), `${reference} stays inside the confirmed performance`);
    const relative = scoped.pathname.slice("/__pnds/run/confirmed/".length);
    const resource = await fetch(`${fixture.performerUrl}/${relative}?checked=1`);
    assert.equal(resource.status, 200, `the actual resource ${relative} is available locally`);
  }
});


test("required styling must finish before a connected candidate reports preparation", async () => {
  const page = browserPage({ styleReady: false });
  await page.setup();
  page.handlers.get("connect")();
  assert.deepEqual(page.reports, [], "usable score images and a connection cannot replace missing styling");
  page.styleEvent("load");
  assert.deepEqual(page.reports, ["prepared"]);
});

test("a required stylesheet failure reports candidate failure and cannot prepare on a later connection", async () => {
  const page = browserPage({ styleReady: false });
  page.styleEvent("error");
  await page.setup();
  page.handlers.get("connect")();
  assert.deepEqual(page.failures, ["failed"]);
  assert.deepEqual(page.reports, []);
});
