// Inarticulate III — score server entry point.
//
// Orchestrates the reusable core (lib/) and the work layer (audio/controller.js):
// - serves performer + monitor pages from public/ on both ports
// - exposes /__pnds/health on both ports
// - manages player identity: claim, takeover, reject
// - forwards point/line events to the audio layer
// - broadcasts visual state and OSC activity to connected clients
// - marks venue projection spectators (?surface=venue) at handshake:
//   read-only, never counted as present, never allowed to claim
// - operator-toggleable info panels for the projection surface
// - shuts down cleanly on SIGINT / SIGTERM

const path = require("node:path");
const fs = require("node:fs");
const libraries = require("./lib/shared-libraries");
const express = libraries.requireLibrary("express");

const {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveAudioMode,
  resolveOscTarget,
  resolveServerConfig,
  resolvePerformerUrl,
  formatAudioMode,
} = require("./lib/config");
const { resolveHostLanIp } = require("./lib/network");
const { HealthTracker } = require("./lib/health");
const { AudioEngine } = require("./lib/audio-engine");
const { decidePlayerClaim } = require("./lib/players");
const {
  attachShutdown,
  closeHttpServer,
} = require("./lib/lifecycle");
const { ProjectAudio, parsePair } = require("./audio/controller");
const { createRecordingAdapter } = require("./lib/recording.cjs");
const { isClaimToken } = require("./lib/players");
const shared = require("./public/shared");

const PROJECT_ROOT = __dirname;
const {
  events: EVENTS,
  playerIds: VALID_PLAYER_IDS,
  storageKeys: STORAGE,
  surfaces: SURFACES,
} = shared;

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
const assignment = serverConfig.runtimeAssignment;
let boundListeners = 0;
function listenerOptions(role) {
  const service = assignment?.services.find(service => service.role === role);
  return service ? { fd: service.fd } : { port: serverConfig[`${role}Port`], host: "0.0.0.0" };
}
function publishRuntimeReport(error) {
  if (!assignment) return;
  const report = {
    version: 1, runId: assignment.runId, status: error ? "error" : "bound",
    services: error ? [] : assignment.services.map(({ role, port }) => ({ role, port })),
    ...(error ? { error: error.message } : {}),
  };
  fs.writeFileSync(`${assignment.reportPath}.tmp`, JSON.stringify(report));
  fs.renameSync(`${assignment.reportPath}.tmp`, assignment.reportPath);
}
function reportBound() {
  if (++boundListeners === 2) publishRuntimeReport();
}
const hostLanIp = resolveHostLanIp(process.env.PNDS_HOST_IP);
const performerUrl = resolvePerformerUrl(process.env, hostLanIp, serverConfig.performerPort);

// ------------------------------------------------------------
// HTTP servers (performer port + monitor port share public/)
// ------------------------------------------------------------

const app = express();
const monitorApp = express();

for (const target of [app, monitorApp]) {
  target.get("/__pnds/context.js", (_request, response) => {
    response.type("application/javascript").send("/* Direct project access: no Host confirmation. */\n");
  });
}
libraries.attachBrowserRoutes(app);
libraries.attachBrowserRoutes(monitorApp);

app.use(express.static(path.join(PROJECT_ROOT, "public")));
monitorApp.use(express.static(path.join(PROJECT_ROOT, "public")));

// Serving role is explicit: an HTTPS performer origin has no local port.
function configScript(role) {
  return (_request, response) => {
    response.type("application/javascript").send(
      `window.__PNDS_CONFIG__ = ${JSON.stringify({
        role, performerUrl,
        performerPort: serverConfig.performerPort,
        monitorPort: serverConfig.monitorPort,
      })};`,
    );
  };
}

app.get("/__config.js", configScript("performer"));
monitorApp.get("/__config.js", configScript("monitor"));

const health = new HealthTracker({
  projectId: manifest.id,
  audioMode,
  performerPort: serverConfig.performerPort,
  monitorPort: serverConfig.monitorPort,
  runtimeRunId: assignment?.runId,
});

app.get("/__pnds/health", health.handler());
monitorApp.get("/__pnds/health", health.handler());

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

const server = app.listen(listenerOptions("performer"), (error) => {
  if (error) {
    publishRuntimeReport(error);
    console.error(`Performer HTTP server failed on port ${serverConfig.performerPort}:`, error);
    process.exit(1);
  }
  reportBound();
  printRuntimeInfo();
});

const monitorServer = monitorApp.listen(
  listenerOptions("monitor"),
  (error) => {
    if (error) {
      publishRuntimeReport(error);
      console.error(`Monitor HTTP server failed on port ${serverConfig.monitorPort}:`, error);
      process.exit(1);
    }
    reportBound();
    console.log(`Monitor page: http://${hostLanIp}:${serverConfig.monitorPort}/`);
  },
);

const io = libraries.requireLibrary("socket.io")(server, {
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

// Whether the projection surface (?surface=venue) currently shows the
// monitor page's side panels (performance intro + OSC table). Operator
// command, server-held so a projection joining late inherits it.
let venuePanelsVisible = false;

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

  releaseSlot(previousSocket);
  recording.unregister(previousSocket.recordingSourceId);
  previousSocket.recordingSourceId = null;
  previousSocket.userType = null;
}

function broadcastClientCount() {
  let count = 0;

  for (const sock of io.sockets.sockets.values()) {
    if (sock.isVenue) {
      continue; // the projection spectator is never present
    }

    if (sock.userType && sock.userType !== "0") {
      count += 1;
    }
  }

  io.emit(EVENTS.clientCount, count);
}

function sendVenuePanelsTo(sock) {
  sock.emit(EVENTS.venuePanels, { visible: venuePanelsVisible });
}

function broadcastVenuePanels() {
  for (const sock of io.sockets.sockets.values()) {
    if (sock.userType === "0" || sock.isVenue) {
      sendVenuePanelsTo(sock);
    }
  }
}

function broadcastOscActivity(address, values) {
  const payload = { address, values };

  for (const sock of io.sockets.sockets.values()) {
    if (sock.userType === "0" || (sock.isVenue && venuePanelsVisible)) {
      sock.emit(EVENTS.oscActivity, payload);
    }
  }
}

// ------------------------------------------------------------
// Socket.IO
// ------------------------------------------------------------

const recordedPoints = new Map();
const pairStrokes = new Map();
const replaySockets = new Map();
const claimSources = new Map();
// Audio slots belong to effective musical sources, independently of UI claims.
const slotOwners = new Map();
function ownsSlot(socket) { return slotOwners.get(String(socket.userType)) === socket; }
function releaseSlot(socket) {
  if (!ownsSlot(socket)) return;
  applyPoint(socket, [], socket.recordingSourceId);
  slotOwners.delete(String(socket.userType));
}
function selectReplaySlot(socket, selection) {
  if (!isPlayerId(selection)) throw new Error('Invalid III recorded selection');
  const owner = slotOwners.get(String(selection));
  if (owner && owner !== socket) throw new Error('Conflicting III recorded membership');
  if (String(socket.userType) !== String(selection)) releaseSlot(socket);
  socket.userType = String(selection);
  slotOwners.set(socket.userType, socket);
}

function applyStroke(data) {
  const parsed = parsePair(data.id);
  const stroke = Math.max(0, Math.min(1, Number(data.stroke)));
  pairStrokes.set(parsed.key, { id: data.id, stroke });
  broadcastOscActivity(`/${data.id}`, [stroke]);
  return projectAudio.setPairStroke(data.id, stroke).catch(error => console.error('[audio] recorded line:', error));
}

async function releaseRecordingSources() {
  for (const socket of [...io.sockets.sockets.values(), ...replaySockets.values()]) {
    if (socket._releaseRetry) clearTimeout(socket._releaseRetry);
    socket._releaseRetry = null;
    socket.lastPVal = undefined;
    socket.pSendCount = 0;
    socket.lastXY = undefined;
  }
  for (const point of recordedPoints.values()) {
    await projectAudio.releasePlayer(point.selection);
    io.emit(EVENTS.pointSend, { clear: true, clientId: point.selection });
  }
  recordedPoints.clear();
  slotOwners.clear();
  replaySockets.clear();
  pairStrokes.clear();
  for (const pair of ['p1-p2', 'p1-p3', 'p2-p3']) await applyStroke({ id: pair, stroke: 0 });
}

const recording = createRecordingAdapter({
  adapterId: 'inarticulate-iii-v1',
  snapshot() { return { points: [...recordedPoints.values()], strokes: [...pairStrokes.values()],
    selections: [...io.sockets.sockets.values()].filter(socket => isPlayerId(socket.userType)).map(socket => ({
      performerId: socket.recordingSourceId, selection: Number(socket.userType),
    })) }; },
  async restore(initialState, performers) {
    if (!Array.isArray(initialState?.points) || !Array.isArray(initialState.strokes)) throw new Error('Invalid III recording state');
    await releaseRecordingSources();
    const selections = new Set();
    for (const performer of performers) {
      if (performer.selection !== null && !isPlayerId(performer.selection)) throw new Error('Invalid III replay selection');
      const initialSelection = initialState.selections?.find(source => source.performerId === performer.id)?.selection;
      if (initialSelection !== undefined) {
        if (!isPlayerId(initialSelection) || selections.has(String(initialSelection))) throw new Error('Invalid III initial membership');
        selections.add(String(initialSelection));
      }
      replaySockets.set(performer.id, { id: 'replay:' + performer.id, userType: initialSelection === undefined ? null : String(initialSelection),
        recordingSourceId: performer.id, broadcast: { emit: (...args) => io.emit(...args) } });
      if (initialSelection !== undefined) slotOwners.set(String(initialSelection), replaySockets.get(performer.id));
    }
    // A reused live device may still display a role now owned by replay. It
    // joins this pass without a role until the creator chooses a free one.
    if (recording.passId) {
      for (const socket of io.sockets.sockets.values()) {
        if (isPlayerId(socket.userType) && slotOwners.has(String(socket.userType))) {
          recording.selection(socket.recordingSourceId, null);
        }
      }
    }
    for (const point of initialState.points) {
      const socket = replaySockets.get(point.performerId);
      if (socket) applyPoint(socket, point.data, point.performerId);
    }
    for (const stroke of initialState.strokes) {
      const pair = parsePair(stroke.id);
      if (selections.has(String(pair.first)) && selections.has(String(pair.second))) await applyStroke(stroke);
    }
  },
  async apply(event) {
    const socket = replaySockets.get(event.performerId);
    if (!socket) throw new Error('Unknown III recorded performer');
    if (event.kind === 'selection' || event.kind === 'join') {
      const selection = event.kind === 'join' ? event.payload.selection : event.payload;
      if (selection === null) { releaseSlot(socket); socket.userType = null; }
      else selectReplaySlot(socket, selection);
    } else if (event.kind === 'point') applyPoint(socket, event.payload, event.performerId);
    else if (event.kind === 'stroke') await applyStroke(event.payload);
    else if (event.kind === 'leave' || event.kind === 'release') {
      if (event.kind === 'leave') { releaseSlot(socket); socket.userType = null; }
      else applyPoint(socket, [], event.performerId);
    }
  },
  release: releaseRecordingSources,
});

app.use((request, response, next) => {
  void recording.handle(request, response).then(handled => { if (!handled) next(); }).catch(next);
});

function applyPoint(socket, data, sourceId) {
    if (!isPlayerId(socket.userType)) {
      return;
    }

    const owner = slotOwners.get(String(socket.userType));
    if (owner && owner !== socket) return;
    if (!owner) slotOwners.set(String(socket.userType), socket);
    const playerId = Number(socket.userType);
    const isActive = !(Array.isArray(data) && data.length === 0);

    if (isActive) recordedPoints.set(socket.id, { performerId: sourceId, selection: playerId, data: structuredClone(data) });
    else recordedPoints.delete(socket.id);

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
        if (slotOwners.get(String(playerId)) !== socket) { socket._releaseRetry = null; return; }
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

}

io.on("connection", (socket) => {
  socket.clientId = nextTempId++;

  // Connection category, not an event: the venue projection client
  // (?surface=venue on the monitor page) declares itself in the handshake
  // because it never sends anything. The mark keeps it out of presence and
  // closes every claim path for it below.
  socket.isVenue = socket.handshake.auth?.surface === SURFACES.venue;

  socket.emit(EVENTS.clientId, socket.clientId);
  broadcastClientCount();

  // A projection joining (or reconnecting) mid-state must not miss the
  // panels decision made before it arrived.
  if (socket.isVenue) {
    sendVenuePanelsTo(socket);
  }

  // ---- Player ID selection ----

  socket.on(EVENTS.selectId, (data) => {
    if (socket.isVenue) {
      // A read-only spectator cannot become an operator or a player.
      return;
    }

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

    if (recording.mode === 'overdub' && [...replaySockets.values()].some(source => source.userType === userType)) {
      socket.emit(EVENTS.idConfirmation, { status: 'rejected', userType, message: 'ID already taken by a recorded performer.' });
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

    if (userType !== socket.userType) {
      releaseSlot(socket);
      if (userType === '0' && isPlayerId(socket.userType)) {
        recording.unregister(socket.recordingSourceId);
        socket.recordingSourceId = null;
      }
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

    if (userType !== '0') {
      const sourceId = socket.recordingSourceId || (isClaimToken(claimToken) ? claimSources.get(claimToken) : null) || recording.newSourceId();
      if (isClaimToken(claimToken)) claimSources.set(claimToken, sourceId);
      socket.recordingSourceId = sourceId;
      recording.register(sourceId, `Performer ${userType}`, Number(userType));
      if (recording.admitted(sourceId) && !slotOwners.has(userType)) slotOwners.set(userType, socket);
    }

    socket.emit(EVENTS.idConfirmation, {
      status: "accepted",
      userType,
    });

    if (userType !== "0") {
      socket.emit(EVENTS.clientId, socket.clientId);
      broadcastClientCount();
    } else {
      // Sync the operator's toggle button with the current state.
      sendVenuePanelsTo(socket);
    }
  });

  // ---- Point event ----

  socket.on(EVENTS.point, (data) => {
    if (!isPlayerId(socket.userType) || !recording.admitted(socket.recordingSourceId) || (slotOwners.has(socket.userType) && !ownsSlot(socket))) return;
    if (!(Array.isArray(data) && data.length === 0) &&
        (!data?.main || ![data.main.x, data.main.y, data.relX ?? 0.5, data.relY ?? 0.5].every(Number.isFinite))) return;
    if (recording.capture(socket.recordingSourceId, 'point', data)) applyPoint(socket, data, socket.recordingSourceId);
  });

  // ---- Line stroke ----

  socket.on(EVENTS.lineStroke, (data) => {
    if (!isPlayerId(socket.userType) || !recording.admitted(socket.recordingSourceId) || (slotOwners.has(socket.userType) && !ownsSlot(socket))) return;
    if (!data || typeof data.id !== 'string' || !Number.isFinite(Number(data.stroke))) return;
    try { parsePair(data.id); } catch { return; }
    if (recording.capture(socket.recordingSourceId, 'stroke', data)) applyStroke(data);
  });

  // ---- Reset all performer roles (operator command) ----

  socket.on(EVENTS.resetRoles, () => {
    if (!recording.conductorAllowed || socket.userType !== "0") {
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

      releaseSlot(sock);

      recording.unregister(sock.recordingSourceId);
      recordedPoints.delete(sock.id);
      sock.userType = null;
      sock.clientId = nextTempId++;
      sock.emit(EVENTS.clientId, sock.clientId);
      sock.emit(EVENTS.rolesReset);
    }

    broadcastClientCount();
  });

  // ---- Projection info panels (operator command) ----

  socket.on(EVENTS.setVenuePanels, (data) => {
    if (socket.userType !== "0") {
      return;
    }

    const visible = Boolean(data && data.visible);

    // No idempotence short-cut: always broadcasting keeps a freshly
    // reloaded operator's button honest even when the state it asked for
    // already held.
    venuePanelsVisible = visible;
    console.log(`[operator] venue info panels ${visible ? "on" : "off"}`);

    broadcastVenuePanels();
  });

  // ---- Disconnect ----

  socket.on("disconnect", () => {
    releaseSlot(socket);
    if (socket.recordingSourceId) recording.unregister(socket.recordingSourceId);
    recordedPoints.delete(socket.id);
    removePlayerAssignment(socket);

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

    // Drop every connected client first — players AND the monitor page's
    // observer sockets. io.close() waits for clients to take their
    // disconnect; a phone on a weak network must not outlive the host's
    // kill window. Per-step elapsed below: a slow step found in the wild
    // is diagnosable from the output tail alone.
    const t0 = Date.now();
    io.disconnectSockets(true);
    io.close();
    const tSockets = Date.now() - t0;

    const t1 = Date.now();
    await projectAudio.stop();
    const tAudio = Date.now() - t1;

    const t2 = Date.now();
    await closeHttpServer(server);
    await closeHttpServer(monitorServer);
    const tHttp = Date.now() - t2;

    console.log(
      `[shutdown] steps: sockets ${tSockets}ms, audio ${tAudio}ms, http ${tHttp}ms`,
    );
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
    `[server] performer page: ${performerUrl}`,
  );
}
