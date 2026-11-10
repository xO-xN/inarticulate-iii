const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const net = require("node:net");
const { io } = require("socket.io-client");
const { once } = require("node:events");
const { runtimeFixture, sharedMap } = require("./support/runtime.cjs");

test("Host shared project starts without local dependencies and serves the full HTTPS performer URL", async t => {
  const advertisedUrl = "https://iii.example.test/performer/?session=three";
  const fixture = await runtimeFixture(t, { environment: { PNDS_PERFORMER_URL: advertisedUrl } });
  assert.equal(fs.existsSync(path.join(fixture.root, "node_modules")), false);
  const health = await fixture.ready();
  assert.equal(health.projectId, "inarticulate-iii");
  for (const [url, role] of [[fixture.performerUrl, "performer"], [fixture.monitorUrl, "monitor"]]) {
    const response = await fetch(`${url}/__config.js`);
    assert.equal(response.status, 200);
    const context = { window: {} };
    vm.runInNewContext(await response.text(), context);
    assert.equal(context.window.__PNDS_CONFIG__.role, role);
    assert.equal(context.window.__PNDS_CONFIG__.performerUrl, advertisedUrl);
  }
  const qr = await fetch(`${fixture.monitorUrl}/qr`);
  assert.equal(qr.status, 404);

  assert.ok(fixture.output().includes(`[server] performer page: ${advertisedUrl}`));
});

test("an occupied monitor port fails startup and releases the performer listener", { timeout: 4000 }, async t => {
  const occupied = net.createServer();
  await new Promise(resolve => occupied.listen(0, "0.0.0.0", resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const fixture = await runtimeFixture(t, { ports: { monitorPort: occupied.address().port } });
  const code = await fixture.exited;
  assert.equal(code, 1);
  assert.match(fixture.output(), /Monitor HTTP server failed.*EADDRINUSE/s);
  assert.doesNotMatch(fixture.output(), /Monitor page:/);
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(fixture.performerPort, "0.0.0.0", resolve); });
  await new Promise(resolve => probe.close(resolve));
});

test("browser libraries are served as exact same-origin files without a directory route", async t => {
  const fixture = await runtimeFixture(t);
  await fixture.ready();
  const libraries = JSON.parse(sharedMap());
  for (const origin of [fixture.performerUrl, fixture.monitorUrl]) {
    for (const id of ["p5", "socket.io"]) {
      const response = await fetch(`${origin}/__pnds/shared/${id}.js`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /javascript/);
      const file = id === "p5" ? libraries[id].path : libraries[id].browserPath;
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(file));
    }
    assert.equal((await fetch(`${origin}/__pnds/shared/catalog.json`)).status, 404);
    assert.equal((await fetch(`${origin}/__pnds/shared/express.js`)).status, 404);
    assert.equal((await fetch(`${origin}/__pnds/shared/`)).status, 404);
  }
});

test("an injected Host map never falls back for missing, wrong-version, or invalid entries", async t => {
  const valid = JSON.parse(sharedMap());
  const cases = [
    ["missing p5", { ...valid, p5: undefined }, /p5@2\.3\.4.*missing/],
    ["wrong express", { ...valid, express: { ...valid.express, version: "4.21.2" } }, /express@5\.3\.0.*mismatched/],
    ["wrong kind", { ...valid, p5: { ...valid.p5, kind: "node" } }, /p5@2\.3\.4.*mismatched/],
    ["relative entry", { ...valid, express: { ...valid.express, path: "express/index.js" } }, /express@5\.3\.0.*entry file.*missing/],
    ["missing osc", { ...valid, "osc-min": undefined }, /osc-min@2\.1\.2.*missing/],
    ["missing browser", { ...valid, "socket.io": { ...valid["socket.io"], browserPath: undefined } }, /socket\.io@4\.8\.4.*browser file.*missing/],
  ];
  for (const [name, map, error] of cases) {
    await t.test(name, { timeout: 3000 }, async subtest => {
      const fixture = await runtimeFixture(subtest, { environment: { PNDS_SHARED_LIBRARIES: JSON.stringify(map) }, localDependencies: true });
      assert.equal(await fixture.exited, 1);
      assert.match(fixture.output(), error);
      assert.doesNotMatch(fixture.output(), /performer page:/);
    });
  }
});

test("invalid injected maps and performer URLs fail before serving", async t => {
  for (const [environment, error] of [
    [{ PNDS_SHARED_LIBRARIES: "invalid" }, /PNDS_SHARED_LIBRARIES is invalid JSON/],
    [{ PNDS_SHARED_LIBRARIES: "[]" }, /PNDS_SHARED_LIBRARIES must be a library map/],
    [{ PNDS_PERFORMER_URL: "https://user:secret@example.test/" }, /PNDS_PERFORMER_URL must be a plain http\(s\) URL/],
    [{ PNDS_PERFORMER_URL: "file:///tmp/score" }, /PNDS_PERFORMER_URL must be a plain http\(s\) URL/],
  ]) {
    await t.test(error.source, { timeout: 3000 }, async subtest => {
      const fixture = await runtimeFixture(subtest, { environment });
      assert.equal(await fixture.exited, 1);
      assert.match(fixture.output(), error);
    });
  }
});

test("standalone refuses a locally installed dependency with a different version", { timeout: 3000 }, async t => {
  const fixture = await runtimeFixture(t, {
    environment: { PNDS_SHARED_LIBRARIES: undefined }, localDependencies: { p5: "1.9.4" },
  });
  assert.equal(await fixture.exited, 1);
  assert.match(fixture.output(), /p5@2\.3\.4.*installed version is 1\.9\.4/);
});

test("standalone remains runnable with the exact npm lock dependencies and LAN HTTP URL", async t => {
  const fixture = await runtimeFixture(t, { environment: { PNDS_SHARED_LIBRARIES: undefined }, localDependencies: true });
  const health = await fixture.ready();
  assert.equal(health.audioMode, "none");
  const context = { window: {} };
  vm.runInNewContext(await (await fetch(`${fixture.performerUrl}/__config.js`)).text(), context);
  assert.equal(context.window.__PNDS_CONFIG__.performerUrl, `${fixture.performerUrl}/`);
  assert.equal((await fetch(`${fixture.performerUrl}/__pnds/shared/p5.js`)).status, 200);
});

test("a performer restores its claim after a transport disconnect and still drives monitor events", { timeout: 4000 }, async t => {
  const fixture = await runtimeFixture(t);
  await fixture.ready();
  const performer = io(fixture.performerUrl, { reconnectionDelay: 10, reconnectionDelayMax: 20 });
  const monitor = io(fixture.performerUrl, { reconnection: false });
  t.after(() => performer.close());
  t.after(() => monitor.close());
  await Promise.all([once(performer, "connect"), once(monitor, "connect")]);
  const claim = async () => {
    const confirmation = once(performer, "idConfirmation");
    performer.emit("selectId", { userType: "2", claimToken: "repeatable-device-2" });
    assert.equal((await confirmation)[0].status, "accepted");
  };
  await claim();
  const operator = once(monitor, "idConfirmation");
  monitor.emit("selectId", { userType: "0" });
  assert.equal((await operator)[0].status, "accepted");
  const originalId = performer.id;
  const reconnected = once(performer, "connect");
  performer.io.engine.close();
  await reconnected;
  assert.notEqual(performer.id, originalId);
  await claim();
  const visual = once(monitor, "pointSend");
  const osc = once(monitor, "oscActivity");
  performer.emit("point", { main: { x: 20, y: 40 }, relX: 0.25, relY: 0.75 });
  assert.equal((await visual)[0].clientId, 2);
  assert.deepEqual((await visual)[0].main, { x: 20, y: 40 });
  assert.equal((await osc)[0].address, "/p2");
});
