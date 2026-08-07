const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const path = require("node:path");

const { io } = require("socket.io-client");

const { events: EVENTS } = require("../public/shared");

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

test("score server: health, selectId, point, lineStroke, resetRoles, pages", async (t) => {
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

  await new Promise((resolve) => {
    opSocket.on(EVENTS.idConfirmation, (data) => {
      assert.equal(data.status, "accepted");
      assert.equal(data.userType, "0");
      resolve();
    });
    opSocket.on(EVENTS.clientId, () => {}); // drain
    opSocket.emit(EVENTS.selectId, { userType: "0" });
  });

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

  // Pages served on both ports
  const performerResponse = await fetch(`${PERFORMER_URL}/`);
  const monitorResponse = await fetch(`${MONITOR_URL}/`);

  assert.equal(performerResponse.status, 200);
  assert.equal(monitorResponse.status, 200);

  const monitorHtml = await monitorResponse.text();
  assert.match(monitorHtml, /sketch\.js/);
});
