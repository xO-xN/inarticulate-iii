// Inarticulate III — score server entry point.
//
// Orchestrates the reusable core (lib/) and the work layer (audio/controller.js):
// - serves performer + monitor pages from public/ on both ports
// - exposes /__pnds/health on both ports
// - manages player identity: claim, takeover, reject
// - forwards point/line events to the audio layer
// - broadcasts visual state and OSC activity to connected clients
// - shuts down cleanly on SIGINT / SIGTERM

const path = require("node:path");
const express = require("express");

const {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveAudioMode,
  resolveOscTarget,
  resolveServerConfig,
  formatAudioMode,
} = require("./lib/config");
const { resolveHostLanIp } = require("./lib/network");
const { HealthTracker } = require("./lib/health");
const { AudioEngine } = require("./lib/audio-engine");
const { decidePlayerClaim } = require("./lib/players");
const { qrHandler } = require("./lib/qr");
const {
  attachShutdown,
  closeHttpServer,
} = require("./lib/lifecycle");
const { ProjectAudio } = require("./audio/controller");
const shared = require("./public/shared");

const PROJECT_ROOT = __dirname;
const { events: EVENTS, playerIds: VALID_PLAYER_IDS, storageKeys: STORAGE } =
  shared;

const VALID_PLAYER_ID_SET = new Set(VALID_PLAYER_IDS);

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const manifest = loadManifest(PROJECT_ROOT);
const cliOptions = parseCliOptions(process.argv.slice(2));

if (cliOptions.help) {
  printUsage();
  process.exit(0);
}

const audioMode = resolveAudioMode(cliOptions.audioMode, manifest);
const oscTarget = resolveOscTarget(cliOptions.oscTarget, manifest, process.env);
const serverConfig = resolveServerConfig(manifest);
const hostLanIp = resolveHostLanIp(process.env.PNDS_HOST_IP);

// ------------------------------------------------------------
// HTTP servers (performer port + monitor port share public/)
// ------------------------------------------------------------

const app = express();
const monitorApp = express();

app.use(express.static(path.join(PROJECT_ROOT, "public")));
monitorApp.use(express.static(path.join(PROJECT_ROOT, "public")));

// Injects manifest ports into the browser so shared.js can read them.
// The single source of truth is manifest.json.
function configScript(request, response) {
  response.type("application/javascript").send(
    `window.__PNDS_CONFIG__ = { performerPort: ${serverConfig.performerPort}, monitorPort: ${serverConfig.monitorPort} };`,
  );
}

app.get("/__config.js", configScript);
monitorApp.get("/__config.js", configScript);

const health = new HealthTracker({
  projectId: manifest.id,
  audioMode,
  performerPort: serverConfig.performerPort,
  monitorPort: serverConfig.monitorPort,
});

app.get("/__pnds/health", health.handler());
monitorApp.get("/__pnds/health", health.handler());

// QR code for the performer page, shown on the monitor page.
monitorApp.get(
  "/qr",
  qrHandler(`http://${hostLanIp}:${serverConfig.performerPort}/`),
);

// ------------------------------------------------------------
// Audio layer
// ------------------------------------------------------------

const audioEngine = new AudioEngine({
  mode: audioMode,
  target: oscTarget,
  projectRoot: PROJECT_ROOT,
  manifest,
  environment: process.env,
});
const projectAudio = new ProjectAudio(audioEngine);

// ------------------------------------------------------------
// Startup
// ------------------------------------------------------------

const server = app.listen(serverConfig.performerPort, "0.0.0.0", () => {
  printRuntimeInfo();
});

const monitorServer = monitorApp.listen(
  serverConfig.monitorPort,
  "0.0.0.0",
  () => {
    console.log(
      `Monitor page: http://${hostLanIp}:${serverConfig.monitorPort}/`,
    );
  },
);

server.on("error", (error) => {
  console.error(
    `Performer HTTP server failed on port ${serverConfig.performerPort}:`,
    error,
  );
  process.exitCode = 1;
});

monitorServer.on("error", (error) => {
  console.error(
    `Monitor HTTP server failed on port ${serverConfig.monitorPort}:`,
    error,
  );
  process.exitCode = 1;
});

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

async function startAudio() {
  health.setAudioStarting();

  try {
    await projectAudio.start();
    health.setAudioReady(
      oscTarget,
    );
  } catch (error) {
    console.error("[audio] start failed:", error);
    health.setError(error);
    process.exitCode = 1;
  }
}

startAudio();

// ------------------------------------------------------------
// Player state
// ------------------------------------------------------------

let nextTempId = 1;
const playerAssignments = new Map();

function isPlayerId(value) {
  return VALID_PLAYER_ID_SET.has(String(value));
}

function removePlayerAssignment(socket) {
  if (!isPlayerId(socket.userType)) {
    return;
  }

  const assignment = playerAssignments.get(socket.userType);

  if (assignment?.socketId === socket.id) {
    playerAssignments.delete(socket.userType);
  }
}

function transferPlayerAssignment(previousSocketId) {
  const previousSocket = io.sockets.sockets.get(previousSocketId);

  if (!previousSocket) {
    return;
  }

  if (previousSocket._releaseRetry) {
    clearTimeout(previousSocket._releaseRetry);
    previousSocket._releaseRetry = null;
  }

  previousSocket.userType = null;
}

function broadcastClientCount() {
  let count = 0;

  for (const sock of io.sockets.sockets.values()) {
    if (sock.userType && sock.userType !== "0") {
      count += 1;
    }
  }

  io.emit(EVENTS.clientCount, count);
}

function broadcastOscActivity(address, values) {
  const payload = { address, values };

  for (const sock of io.sockets.sockets.values()) {
    if (sock.userType === "0") {
      sock.emit(EVENTS.oscActivity, payload);
    }
  }
}

// ------------------------------------------------------------
// Socket.IO
// ------------------------------------------------------------

io.on("connection", (socket) => {
  socket.clientId = nextTempId++;
  socket.emit(EVENTS.clientId, socket.clientId);
  broadcastClientCount();

  // ---- Player ID selection ----

  socket.on(EVENTS.selectId, (data) => {
    const userType =
      data && data.userType !== undefined ? String(data.userType) : null;
    const claimToken = data?.claimToken;

    if (userType !== "0" && !isPlayerId(userType)) {
      socket.emit(EVENTS.idConfirmation, {
        status: "rejected",
        userType,
        message: "Invalid player ID.",
      });
      return;
    }

    let selectStatus = "accepted";

    if (userType !== "0") {
      const decision = decidePlayerClaim(playerAssignments, {
        playerId: userType,
        socketId: socket.id,
        claimToken,
      });

      if (decision.status === "rejected") {
        console.log(
          `[protocol] select ${userType} rejected: ${decision.message}`,
        );
        socket.emit(EVENTS.idConfirmation, {
          status: "rejected",
          userType,
          message: decision.message,
        });
        return;
      }

      if (decision.status === "takeover") {
        transferPlayerAssignment(decision.previousSocketId);
      }

      selectStatus = decision.status;
    }

    removePlayerAssignment(socket);
    socket.userType = userType;

    console.log(
      userType === "0"
        ? "[protocol] select: operator"
        : `[protocol] select: player ${userType} (${selectStatus})`,
    );

    if (userType !== "0") {
      playerAssignments.set(userType, {
        socketId: socket.id,
        claimToken,
      });
      socket.clientId = parseInt(userType, 10);
    }

    socket.emit(EVENTS.idConfirmation, {
      status: "accepted",
      userType,
    });

    if (userType !== "0") {
      socket.emit(EVENTS.clientId, socket.clientId);
      broadcastClientCount();
    }
  });

  // ---- Point event ----

  socket.on(EVENTS.point, (data) => {
    if (!isPlayerId(socket.userType)) {
      return;
    }

    const playerId = Number(socket.userType);
    const isActive = !(Array.isArray(data) && data.length === 0);

    // Broadcast point data to other browsers
    if (!isActive) {
      socket.broadcast.emit(EVENTS.pointSend, {
        clear: true,
        clientId: playerId,
      });
    } else if (data && data.main) {
      socket.broadcast.emit(EVENTS.pointSend, {
        clientId: playerId,
        main: data.main,
        amp: data.amp,
      });
    }

    // Cancel pending release retries
    if (socket._releaseRetry) {
      clearTimeout(socket._releaseRetry);
      socket._releaseRetry = null;
    }

    // Gate
    if (isActive) {
      if (socket.lastPVal === undefined) {
        socket.lastPVal = -1;
      }

      if (socket.pSendCount === undefined) {
        socket.pSendCount = 0;
      }

      if (socket.lastPVal !== 1) {
        socket.lastPVal = 1;
        socket.pSendCount = 0;
      }

      if (socket.pSendCount < 3) {
        broadcastOscActivity(`/p${playerId}`, [1]);

        projectAudio.setPlayerGate(playerId, 1).catch((error) => {
          console.error(`[audio] player ${playerId} gate on failed:`, error);
        });

        socket.pSendCount += 1;
      }
    } else {
      socket.lastPVal = 0;
      socket.pSendCount = 0;

      const sendRelease = () => {
        broadcastOscActivity(`/p${playerId}`, [0]);

        projectAudio.releasePlayer(playerId).catch((error) => {
          console.error(`[audio] player ${playerId} release failed:`, error);
        });

        socket.pSendCount += 1;

        if (socket.pSendCount < 3) {
          socket._releaseRetry = setTimeout(sendRelease, 50);
        } else {
          socket._releaseRetry = null;
        }
      };

      sendRelease();
    }

    // Position data
    if (socket.lastXY === undefined) {
      socket.lastXY = { relX: null, relY: null, amp: null };
    }

    if (isActive && data && data.main) {
      const relX =
        data.relX !== undefined ? Number(data.relX) : 0.5;
      const relY =
        data.relY !== undefined ? Number(data.relY) : 0.5;

      const rawAmp =
        data.amp && Number.isFinite(Number(data.amp.length))
          ? Number(data.amp.length)
          : 0;

      const amp = Math.max(0, Math.min(1, rawAmp));
      const last = socket.lastXY;

      if (relX !== last.relX || relY !== last.relY || amp !== last.amp) {
        socket.lastXY = { relX, relY, amp };

        broadcastOscActivity(`/p${playerId}xy`, [relX, relY, amp]);

        projectAudio
          .setPlayerPosition(playerId, { x: relX, y: relY, amp })
          .catch((error) => {
            console.error(
              `[audio] player ${playerId} position failed:`,
              error,
            );
          });
      }
    } else if (!isActive) {
      socket.lastXY = { relX: null, relY: null, amp: null };
    }
  });

  // ---- Line stroke ----

  socket.on(EVENTS.lineStroke, (data) => {
    if (!isPlayerId(socket.userType)) {
      return;
    }

    if (!data || typeof data.id !== "string") {
      console.warn("[audio] ignoring invalid lineStroke:", data);
      return;
    }

    const stroke = Number(data.stroke);

    if (!Number.isFinite(stroke)) {
      console.warn("[audio] ignoring invalid line stroke value:", data);
      return;
    }

    broadcastOscActivity(`/${data.id}`, [stroke]);

    projectAudio.setPairStroke(data.id, stroke).catch((error) => {
      console.error(`[audio] line ${data.id} failed:`, error);
    });
  });

  // ---- Reset all performer roles (operator command) ----

  socket.on(EVENTS.resetRoles, () => {
    if (socket.userType !== "0") {
      return;
    }

    console.log("[operator] Resetting all performer roles");

    const performerSockets = [];
    for (const [, assignment] of playerAssignments) {
      const sock = io.sockets.sockets.get(assignment.socketId);
      if (sock && sock.userType && sock.userType !== "0") {
        performerSockets.push(sock);
      }
    }

    playerAssignments.clear();

    for (const sock of performerSockets) {
      if (sock._releaseRetry) {
        clearTimeout(sock._releaseRetry);
        sock._releaseRetry = null;
      }

      projectAudio
        .releasePlayer(Number(sock.userType))
        .catch((error) => {
          console.error(
            `[audio] player ${sock.userType} reset failed:`,
            error,
          );
        });

      sock.userType = null;
      sock.clientId = nextTempId++;
      sock.emit(EVENTS.clientId, sock.clientId);
      sock.emit(EVENTS.rolesReset);
    }

    broadcastClientCount();
  });

  // ---- Disconnect ----

  socket.on("disconnect", () => {
    const isPlayer = isPlayerId(socket.userType);

    if (isPlayer) {
      const playerId = Number(socket.userType);

      console.log(`[protocol] disconnect: player ${playerId}`);
      broadcastOscActivity(`/p${playerId}`, [0]);

      projectAudio.releasePlayer(playerId).catch((error) => {
        console.error(
          `[audio] player ${playerId} disconnect failed:`,
          error,
        );
      });

      socket.broadcast.emit(EVENTS.pointSend, {
        clear: true,
        clientId: playerId,
      });

      removePlayerAssignment(socket);
    }

    if (socket._releaseRetry) {
      clearTimeout(socket._releaseRetry);
      socket._releaseRetry = null;
    }

    delete socket.clientId;
    delete socket.userType;

    broadcastClientCount();
  });
});

// ------------------------------------------------------------
// Shutdown
// ------------------------------------------------------------

attachShutdown({
  onShutdown: async () => {
    health.setStopping();

    // Clear release retries
    for (const socket of io.sockets.sockets.values()) {
      if (socket._releaseRetry) {
        clearTimeout(socket._releaseRetry);
        socket._releaseRetry = null;
      }
    }

    io.close();
    await projectAudio.stop();
    await closeHttpServer(server);
    await closeHttpServer(monitorServer);
  },
});

// ------------------------------------------------------------
// Console output
// ------------------------------------------------------------

function printRuntimeInfo() {
  console.log(`[server] ${manifest.name} v${manifest.version}`);
  console.log(
    `[server] audio mode: ${formatAudioMode(audioMode)} (target ${oscTarget})`,
  );
  console.log(
    `[server] performer page: http://${hostLanIp}:${serverConfig.performerPort}/`,
  );
}
