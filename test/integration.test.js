const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");
const vm = require("node:vm");

const { io } = require("socket.io-client");

const { events: EVENTS, surfaces: SURFACES } = require("../public/shared");

const { PROJECT_ROOT, runtimeFixture } = require("./support/runtime.cjs");

async function fetchPageScripts(origin) {
  return Promise.all(
    ["__config.js", "shared.js", "sketch.js"].map(async (file) => {
      const response = await fetch(`${origin}/${file}`);
      assert.equal(response.status, 200, `${origin}/${file}`);
      return response.text();
    }),
  );
}

async function renderPage(scripts, url) {
  let mode = null;
  let surface = null;
  const context = vm.createContext({
    URLSearchParams,
    location: new URL(url),
    crypto: globalThis.crypto,
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {},
    scrollTo() {},
    createCanvas: () => ({ elt: { addEventListener() {} } }),
    loadImage: async () => ({}),
    frameRate() {},
    windowWidth: 800,
    windowHeight: 600,
    document: {
      body: {
        classList: {
          add(className) {
            mode = className;
          },
        },
      },
      addEventListener() {},
      getElementById: () => ({ addEventListener() {} }),
    },
    io: {
      connect(_origin, options) {
        surface = options.auth?.surface ?? null;
        return { on() {} };
      },
    },
  });
  context.window = context;
  for (const script of scripts) vm.runInContext(script, context);
  await vm.runInContext("setup()", context);
  return { role: context.__PNDS_CONFIG__.role, mode, surface };
}

test("score server: health, selectId, point, lineStroke, resetRoles, pages", async (t) => {
  const fixture = await runtimeFixture(t);
  const PERFORMER_URL = fixture.performerUrl;
  const MONITOR_URL = fixture.monitorUrl;
  const health = await fixture.ready();

  assert.equal(health.projectId, "inarticulate-iii");
  assert.ok(
    health.audioMode === "none" || health.audioMode === "internal",
    `unexpected audioMode: ${health.audioMode}`,
  );
  assert.ok(
    health.audio.status === "ready" || health.audio.status === "disabled",
    `unexpected audio.status: ${health.audio.status}`,
  );
  assert.equal(health.scoreServer.performerPort, fixture.performerPort);
  assert.equal(health.scoreServer.monitorPort, fixture.monitorPort);

  await t.test("proxied pages keep the role of their serving listener", async () => {
    const [monitorScripts, performerScripts] = await Promise.all([
      fetchPageScripts(MONITOR_URL),
      fetchPageScripts(PERFORMER_URL),
    ]);
    // The App forwards these scripts from the score server while WebView
    // exposes a private address with a separate port for each page.
    assert.deepEqual(
      await renderPage(monitorScripts, "http://pnds-monitor.localhost:54129/"),
      { role: "monitor", mode: "monitor-mode", surface: null },
    );
    assert.deepEqual(
      await renderPage(monitorScripts, "http://pnds-projection.localhost:54130/?surface=venue"),
      { role: "monitor", mode: "venue-mode", surface: "venue" },
    );
    assert.deepEqual(
      await renderPage(performerScripts, "http://pnds-performer.localhost:54131/?surface=venue"),
      { role: "performer", mode: null, surface: null },
    );
  });

  // Player 1 joins
  const p1Socket = io(PERFORMER_URL, { reconnection: false });
  t.after(() => p1Socket.close());

  await new Promise((resolve) => {
    p1Socket.on(EVENTS.clientId, (id) => {
      assert.ok(typeof id === "number");
      resolve();
    });
  });

  p1Socket.emit(EVENTS.selectId, { userType: "1" });

  const p1Confirm = await new Promise((resolve) => {
    p1Socket.on(EVENTS.idConfirmation, resolve);
  });

  assert.equal(p1Confirm.status, "accepted");
  assert.equal(p1Confirm.userType, "1");

  // Operator joins on the other port
  const opSocket = io(PERFORMER_URL, { reconnection: false });
  t.after(() => opSocket.close());

  const opPanelsSync = [];
  opSocket.on(EVENTS.venuePanels, (data) => opPanelsSync.push(data));

  await new Promise((resolve) => {
    opSocket.on(EVENTS.idConfirmation, (data) => {
      assert.equal(data.status, "accepted");
      assert.equal(data.userType, "0");
      resolve();
    });
    opSocket.on(EVENTS.clientId, () => {}); // drain
    opSocket.emit(EVENTS.selectId, { userType: "0" });
  });

  assert.ok(
    await new Promise((resolve) => {
      if (opPanelsSync.length > 0) {
        resolve(true);
        return;
      }
      opSocket.once(EVENTS.venuePanels, () => resolve(true));
      setTimeout(() => resolve(false), 300);
    }),
    "the operator receives the panels state on selectId",
  );

  assert.deepEqual(
    opPanelsSync,
    [{ visible: false }],
    "the operator's toggle state syncs on selectId (reload recovery)",
  );

  // Operator receives oscActivity for point + lineStroke
  const activitySeen = new Promise((resolve) => {
    opSocket.on(EVENTS.oscActivity, (data) => {
      if (data.address === "/p1-p2") {
        resolve(data);
      }
    });
  });

  p1Socket.emit(EVENTS.point, { main: { x: 100, y: 200 }, relX: 0.5, relY: 0.5 });
  p1Socket.emit(EVENTS.lineStroke, { id: "p1-p2", stroke: 0.5 });

  const activity = await activitySeen;
  assert.equal(activity.address, "/p1-p2");

  // Venue projection surface (monitor page + ?surface=venue): a read-only
  // spectator. Its connection category is declared in the handshake — the
  // venue page never sends an event — so it is invisible to presence and
  // cannot claim a role, yet still rides the same broadcasts to render.
  const countOnVenueConnect = new Promise((resolve) => {
    opSocket.once(EVENTS.clientCount, resolve);
  });

  const venueSocket = io(PERFORMER_URL, {
    reconnection: false,
    auth: { surface: SURFACES.venue },
  });
  t.after(() => venueSocket.close());

  const venuePanelsUpdates = [];
  venueSocket.on(EVENTS.venuePanels, (data) =>
    venuePanelsUpdates.push(data),
  );

  await new Promise((resolve) => venueSocket.once("connect", resolve));

  assert.equal(
    await countOnVenueConnect,
    1,
    "the venue connection re-broadcasts the count — still only player 1",
  );

  assert.deepEqual(
    venuePanelsUpdates,
    [{ visible: false }],
    "a fresh venue connection inherits the current panels state (off)",
  );

  // Panels off: the OSC stream stays operator-only.
  p1Socket.emit(EVENTS.lineStroke, { id: "p1-p3", stroke: 0.3 });

  assert.ok(
    await new Promise((resolve) => {
      venueSocket.once(EVENTS.oscActivity, () => resolve(false));
      setTimeout(() => resolve(true), 300);
    }),
    "no oscActivity reaches the venue while its panels are off",
  );

  const venueSawPoint = new Promise((resolve) => {
    venueSocket.once(EVENTS.pointSend, resolve);
  });

  p1Socket.emit(EVENTS.point, { main: { x: 10, y: 20 }, relX: 0.5, relY: 0.5 });

  const venuePoint = await venueSawPoint;
  assert.equal(venuePoint.clientId, 1);
  assert.deepEqual(venuePoint.main, { x: 10, y: 20 });

  // The venue socket is read-only itself: its own command is ignored too.
  venueSocket.emit(EVENTS.setVenuePanels, { visible: true });

  assert.ok(
    await new Promise((resolve) => {
      venueSocket.once(EVENTS.venuePanels, () => resolve(false));
      setTimeout(() => resolve(true), 300);
    }),
    "a venue socket's setVenuePanels is ignored",
  );

  // Operator toggles the projection info panels: the venue page shows the
  // monitor page's side content — performance intro and OSC table.
  const venueSawPanelsOn = new Promise((resolve) => {
    venueSocket.once(EVENTS.venuePanels, resolve);
  });

  opSocket.emit(EVENTS.setVenuePanels, { visible: true });

  assert.deepEqual(await venueSawPanelsOn, { visible: true });

  // With the panels on, the venue rides the OSC activity stream too.
  const venueSawOsc = new Promise((resolve) => {
    venueSocket.once(EVENTS.oscActivity, resolve);
  });

  p1Socket.emit(EVENTS.lineStroke, { id: "p1-p2", stroke: 0.7 });

  assert.equal((await venueSawOsc).address, "/p1-p2");

  // A projection joining later inherits the current state on connect.
  const venue2Socket = io(PERFORMER_URL, {
    reconnection: false,
    auth: { surface: SURFACES.venue },
  });
  const venue2State = new Promise((resolve) => {
    venue2Socket.once(EVENTS.venuePanels, resolve);
  });
  t.after(() => venue2Socket.close());

  await new Promise((resolve) => venue2Socket.once("connect", resolve));

  assert.deepEqual(await venue2State, { visible: true });

  // Only the operator may toggle: a player's command changes nothing.
  p1Socket.emit(EVENTS.setVenuePanels, { visible: false });

  assert.ok(
    await new Promise((resolve) => {
      venueSocket.once(EVENTS.venuePanels, () => resolve(false));
      setTimeout(() => resolve(true), 300);
    }),
    "a player's setVenuePanels is ignored",
  );

  const venueSawPanelsOff = new Promise((resolve) => {
    venueSocket.once(EVENTS.venuePanels, resolve);
  });

  opSocket.emit(EVENTS.setVenuePanels, { visible: false });

  assert.deepEqual(await venueSawPanelsOff, { visible: false });

  assert.deepEqual(
    venuePanelsUpdates,
    [{ visible: false }, { visible: true }, { visible: false }],
    "the venue saw connect/on/off — the ignored player toggle added nothing",
  );

  const countAfterVenueClaim = new Promise((resolve) => {
    opSocket.once(EVENTS.clientCount, resolve);
  });

  venueSocket.emit(EVENTS.selectId, { userType: "2" });

  assert.ok(
    await new Promise((resolve) => {
      venueSocket.once(EVENTS.idConfirmation, () => resolve(false));
      setTimeout(() => resolve(true), 300);
    }),
    "a venue socket receives no idConfirmation for a claim attempt",
  );

  venueSocket.close();

  assert.equal(
    await countAfterVenueClaim,
    1,
    "the venue disconnect re-broadcasts the count — the claim never landed",
  );

  // Pages served on both ports
  const performerResponse = await fetch(`${PERFORMER_URL}/`);
  const monitorResponse = await fetch(`${MONITOR_URL}/`);
  const venueResponse = await fetch(`${MONITOR_URL}/?surface=venue`);
  const unknownParamResponse = await fetch(`${MONITOR_URL}/?anything=1`);

  assert.equal(performerResponse.status, 200);
  assert.equal(monitorResponse.status, 200);
  assert.equal(venueResponse.status, 200);
  assert.equal(unknownParamResponse.status, 200);

  const monitorHtml = await monitorResponse.text();
  assert.match(monitorHtml, /sketch\.js/);
});

test("shutdown: SIGTERM completes promptly with live clients still connected", async (t) => {
  const fixture = await runtimeFixture(t);
  const server = fixture.child;
  const PERFORMER_URL = fixture.performerUrl;
  await fixture.ready();

  // The worst case the App leaves behind on stop: a seated player
  // (websocket), a polling-only client (a phone on a weak network), and
  // raw keep-alive HTTP connections on both ports (the monitor webview's
  // page stays mounted through the stop fade).
  const player = io(PERFORMER_URL, { reconnection: false });
  t.after(() => player.close());

  await new Promise((resolve) => player.once("connect", resolve));

  const playerConfirm = await new Promise((resolve) => {
    player.once(EVENTS.idConfirmation, resolve);
    player.emit(EVENTS.selectId, { userType: "1" });
  });

  assert.equal(playerConfirm.status, "accepted");

  const polling = io(PERFORMER_URL, {
    transports: ["polling"],
    reconnection: false,
  });

  await new Promise((resolve) => polling.once("connect", resolve));
  t.after(() => polling.close());

  const raw = [];

  for (const port of [fixture.performerPort, fixture.monitorPort]) {
    const socket = net.connect({ port, host: "127.0.0.1" });

    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
    );
    raw.push(socket);
  }
  t.after(() => raw.forEach((s) => s.destroy()));

  const startedAt = Date.now();

  server.kill("SIGTERM");

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server did not exit within 2 s of SIGTERM")),
      2000,
    );

    server.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const elapsed = Date.now() - startedAt;

  // The host's kill window is 5 s (then SIGKILL, and the operator stares
  // at a blank stop cover meanwhile): the server must be long gone
  // before that window closes.
  assert.equal(exitCode, 0, "graceful shutdown completes");
  assert.ok(
    elapsed < 1000,
    `shutdown took ${elapsed} ms with live clients still connected`,
  );
});

test("shipped monitor bundle: the ?surface=venue spectator branch", () => {
  const sketch = fs.readFileSync(
    path.join(PROJECT_ROOT, "public", "sketch.js"),
    "utf8",
  );
  const style = fs.readFileSync(
    path.join(PROJECT_ROOT, "public", "style.css"),
    "utf8",
  );
  const html = fs.readFileSync(
    path.join(PROJECT_ROOT, "public", "index.html"),
    "utf8",
  );
  const sharedSource = fs.readFileSync(
    path.join(PROJECT_ROOT, "public", "shared.js"),
    "utf8",
  );

  // The venue page is the monitor page plus the query: it must carry the
  // branch that turns it into a canvas-only spectator.
  assert.match(
    sketch,
    /get\("surface"\) === P\.surfaces\.venue/,
    "sketch reads ?surface=venue via the shared constant",
  );
  assert.match(sketch, /venue-mode/, "sketch flags the venue body class");
  assert.match(
    sketch,
    /auth:\s*\{\s*surface:\s*P\.surfaces\.venue\s*\}/,
    "sketch marks the connection category at handshake",
  );
  assert.match(
    style,
    /body\.venue-mode \.badge\s*\{\s*display:\s*none/,
    "style hides the runtime chrome on the venue surface",
  );
  assert.match(
    sharedSource,
    /venue:\s*"venue"/,
    "shared.js defines the venue surface value",
  );

  // The operator's projection info toggle: a third button in the
  // bottom-left group, wired to the venue panels state.
  assert.match(
    html,
    /id="venue-panels"/,
    "monitor page ships the venue panels toggle button",
  );
  assert.match(
    style,
    /body\.venue-panels \.monitor-panel/,
    "style shows the monitor panels on the venue surface when toggled on",
  );
});
