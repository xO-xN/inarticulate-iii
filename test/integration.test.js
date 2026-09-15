const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");

const { io } = require("socket.io-client");

const { events: EVENTS, surfaces: SURFACES } = require("../public/shared");

const PROJECT_ROOT = path.join(__dirname, "..");
const PERFORMER_URL = `http://127.0.0.1:${require("../manifest.json").scoreServer.performerPort}`;
const MONITOR_URL = `http://127.0.0.1:${require("../manifest.json").scoreServer.monitorPort}`;
const HEALTH_URL = `${PERFORMER_URL}/__pnds/health`;

function waitForHealthReady() {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const tick = async () => {
      attempts += 1;

      try {
        const response = await fetch(HEALTH_URL);
        const payload = await response.json();

        if (payload.status === "ready") {
          resolve(payload);
          return;
        }
      } catch {
        // server not up yet
      }

      if (attempts >= 40) {
        reject(new Error("server never reported health ready"));
        return;
      }

      setTimeout(tick, 250);
    };

    tick();
  });
}

// Fails fast with an actionable message when a dev server already holds
// the ports — otherwise the spawned server cannot bind and the health
// poll would silently talk to the wrong instance.
async function assertPortsFree() {
  for (const port of [6868, 6869]) {
    const inUse = await new Promise((resolve) => {
      const probe = net.connect({ port, host: "127.0.0.1" });

      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });

    if (inUse) {
      throw new Error(
        `Port ${port} is already in use — stop running dev servers (npm run dev / dev:none) before the integration test.`,
      );
    }
  }
}

test("score server: health, selectId, point, lineStroke, resetRoles, pages", async (t) => {
  await assertPortsFree();

  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(() => server.kill("SIGTERM"));

  const health = await waitForHealthReady();

  assert.equal(health.projectId, "inarticulate-iii");
  assert.ok(
    health.audioMode === "none" || health.audioMode === "internal",
    `unexpected audioMode: ${health.audioMode}`,
  );
  assert.ok(
    health.audio.status === "ready" || health.audio.status === "disabled",
    `unexpected audio.status: ${health.audio.status}`,
  );
  assert.equal(health.scoreServer.performerPort, 6868);
  assert.equal(health.scoreServer.monitorPort, 6869);

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
  // The previous test's teardown signals its server but does not wait
  // for the exit; give the ports a moment before claiming them.
  const portFree = (port) =>
    new Promise((resolve) => {
      const probe = net.connect({ port, host: "127.0.0.1" });

      probe.once("connect", () => {
        probe.destroy();
        resolve(false);
      });
      probe.once("error", () => resolve(true));
    });

  const portsFree = async () =>
    (await portFree(6868)) && (await portFree(6869));

  const deadline = Date.now() + 5000;

  while (Date.now() < deadline && !(await portsFree())) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(
    await portsFree(),
    "the previous test's server never released the ports",
  );

  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "ignore", "ignore"],
  });
  t.after(() => server.kill("SIGKILL"));

  await waitForHealthReady();

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

  for (const port of [6868, 6869]) {
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
