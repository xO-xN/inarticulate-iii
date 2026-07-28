const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const os = require("node:os");
const net = require("node:net");
const QRCode = require("qrcode");
const qrcode = require("qrcode-terminal");
const { AudioController } = require("./audio/audio-controller");

const PROJECT_ROOT = __dirname;
const MANIFEST_PATH = path.join(PROJECT_ROOT, "manifest.json");

const VALID_AUDIO_MODES = new Set([
  "internal",
  "external",
  "none",
]);

const VALID_PLAYER_IDS = new Set([
  "1",
  "2",
  "3",
]);


// ============================================================
// Project configuration
// ============================================================

const manifest = loadManifest(MANIFEST_PATH);
const cliOptions = parseCliOptions(process.argv.slice(2));

const audioMode = resolveAudioMode(
  cliOptions.audioMode,
  manifest,
);

const oscTarget = resolveOscTarget(
  audioMode,
  manifest,
);

const serverConfig = resolveServerConfig(
  manifest,
);

// The PNDS App supplies the LAN address explicitly after the user selects
// it. Standalone development falls back to the first non-loopback IPv4.
const hostLanIp = resolveHostLanIp();


// ============================================================
// Express applications
// ============================================================

const app = express();
const obApp = express();

app.use(
  express.static(
    path.join(PROJECT_ROOT, "public"),
  ),
);

obApp.use(
  express.static(
    path.join(PROJECT_ROOT, "public"),
  ),
);


// ============================================================
// Audio controller
// ============================================================
//
// AudioController 内部根据 audioMode 选择：
//
// internal
//     /n_set、/s_new、/d_load
//
// external
//     /p1、/p1xy、/p1-p2
//
// none
//     no-op
// ============================================================

const audioController = new AudioController({
  mode: audioMode,
  target: oscTarget,
  projectRoot: PROJECT_ROOT,
  manifest,
});

let audioStartupError = null;
let audioStatus = audioMode === "none" ? "disabled" : "starting";
let performerListening = false;
let monitorListening = false;
let serverStartupError = null;
let isShuttingDown = false;
let shutdownPromise = null;

const audioReady = audioController
  .start()
  .then(() => {
    audioStatus = audioMode === "none" ? "disabled" : "ready";

    console.log(
      `[audio] ${formatAudioMode(audioMode)} ready.`,
    );

    return true;
  })
  .catch((error) => {
    audioStartupError = error;
    audioStatus = "error";

    console.error(
      `[audio] failed to start ${formatAudioMode(audioMode)}:`,
      error,
    );

    // 音频不可用时仍保留 HTTP 和 Socket.IO，
    // 以便 PNDS App 和网页端读取明确的 error 状态。
    return false;
  });


// 所有 Socket.IO 事件通过这个函数进入 AudioController。
function dispatchAudio(label, operation) {
  if (isShuttingDown) {
    return Promise.resolve();
  }

  return audioReady
    .then((ready) => {
      if (!ready) {
        console.warn(
          `[audio] skipped "${label}" because audio is unavailable.`,
        );

        return undefined;
      }

      return operation();
    })
    .catch((error) => {
      console.error(
        `[audio] ${label} failed:`,
        error,
      );

      return undefined;
    });
}


// ============================================================
// PNDS runtime health
// ============================================================

function getRuntimeStatus() {
  if (isShuttingDown) {
    return "stopping";
  }

  if (audioStatus === "error" || serverStartupError) {
    return "error";
  }

  if (!performerListening || !monitorListening || audioStatus === "starting") {
    return "starting";
  }

  return "ready";
}

function getHealthPayload() {
  const payload = {
    status: getRuntimeStatus(),
    projectId: manifest.id,
    audioMode,
    audio: {
      status: audioStatus,
      target: oscTarget ? oscTarget.display : null,
    },
    scoreServer: {
      performerPort: serverConfig.performerPort,
      monitorPort: serverConfig.monitorPort,
    },
  };

  if (audioStartupError) {
    payload.audio.error = audioStartupError.message;
  }

  if (serverStartupError) {
    payload.scoreServer.error = serverStartupError.message;
  }

  return payload;
}

function healthHandler(request, response) {
  response.json(getHealthPayload());
}

app.get("/__pnds/health", healthHandler);
obApp.get("/__pnds/health", healthHandler);


// ============================================================
// HTTP servers
// ============================================================

const server = app.listen(
  serverConfig.performerPort,
  "0.0.0.0",
  () => {
    performerListening = true;
    printRuntimeInfo();
    printServerInfo();
  },
);

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const monitorServer = obApp.listen(
  serverConfig.monitorPort,
  "0.0.0.0",
  () => {
    monitorListening = true;
    console.log(
      `Operator view listening on port ${serverConfig.monitorPort}`,
    );
  },
);

server.on("error", (error) => {
  console.error(
    `Performer HTTP server failed on port ${serverConfig.performerPort}:`,
    error,
  );

  serverStartupError = error;
  process.exitCode = 1;
});

monitorServer.on("error", (error) => {
  console.error(
    `Monitor HTTP server failed on port ${serverConfig.monitorPort}:`,
    error,
  );

  serverStartupError = error;
  process.exitCode = 1;
});


// ============================================================
// Manifest and configuration helpers
// ============================================================

function loadManifest(manifestPath) {
  let rawManifest;

  try {
    rawManifest = fs.readFileSync(
      manifestPath,
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `Unable to read manifest.json at ${manifestPath}: ${error.message}`,
    );
  }

  try {
    return JSON.parse(rawManifest);
  } catch (error) {
    throw new Error(
      `Unable to parse manifest.json at ${manifestPath}: ${error.message}`,
    );
  }
}

function parseCliOptions(args) {
  let audioMode = null;

  for (
    let index = 0;
    index < args.length;
    index += 1
  ) {
    const argument = args[index];

    if (argument === "--audio-mode") {
      const nextArgument = args[index + 1];

      if (
        !nextArgument ||
        nextArgument.startsWith("--")
      ) {
        throw new Error(
          "Missing value for --audio-mode. " +
            "Expected internal, external, or none.",
        );
      }

      audioMode = nextArgument;
      index += 1;
      continue;
    }

    if (argument.startsWith("--audio-mode=")) {
      audioMode = argument.slice(
        "--audio-mode=".length,
      );
      continue;
    }

    if (
      argument === "--help" ||
      argument === "-h"
    ) {
      printUsage();
      process.exit(0);
    }

    throw new Error(
      `Unknown command-line argument: ${argument}. ` +
        "Use --audio-mode internal|external|none.",
    );
  }

  return {
    audioMode,
  };
}

function printUsage() {
  console.log(
    "Usage: node server.js " +
      "[--audio-mode internal|external|none]",
  );

  console.log("");
  console.log("Configuration:");
  console.log(
    "  PNDS_OSC_TARGET=host:port",
  );

  console.log("");
  console.log("Examples:");

  console.log(
    "  node server.js",
  );

  console.log(
    "  node server.js --audio-mode internal",
  );

  console.log(
    "  PNDS_OSC_TARGET=127.0.0.1:57120 " +
      "node server.js --audio-mode external",
  );

  console.log(
    "  node server.js --audio-mode none",
  );
}

function resolveAudioMode(cliMode, currentManifest) {
  const manifestAudio =
    currentManifest.audio || {};

  const requestedMode =
    cliMode ||
    manifestAudio.defaultMode;

  const supportedModes =
    manifestAudio.supportedModes || [];

  if (!requestedMode) {
    throw new Error(
      "No audio mode configured. " +
        "Set audio.defaultMode in manifest.json " +
        "or use --audio-mode.",
    );
  }

  if (!VALID_AUDIO_MODES.has(requestedMode)) {
    throw new Error(
      `Unsupported audio mode: ${requestedMode}. ` +
        "Expected internal, external, or none.",
    );
  }

  if (
    supportedModes.length > 0 &&
    !supportedModes.includes(requestedMode)
  ) {
    throw new Error(
      `Audio mode '${requestedMode}' is not supported ` +
        "by this PNDS project. " +
        `Supported modes: ${supportedModes.join(", ")}.`,
    );
  }

  return requestedMode;
}

function resolveOscTarget(
  mode,
  currentManifest,
) {
  if (mode === "none") {
    return null;
  }

  const environmentTarget =
    process.env.PNDS_OSC_TARGET?.trim();

  const standaloneTarget =
    currentManifest.audio?.standaloneTarget;

  let rawTarget = environmentTarget;

  // 只有 Internal 模式可以使用 standaloneTarget。
  // External 模式必须由 App 或用户通过
  // PNDS_OSC_TARGET 提供目标。
  if (!rawTarget && mode === "internal") {
    rawTarget = standaloneTarget;
  }

  if (!rawTarget) {
    throw new Error(
      `No OSC target configured for '${mode}' mode. ` +
        "Set PNDS_OSC_TARGET=host:port.",
    );
  }

  return parseOscTarget(rawTarget);
}

function parseOscTarget(rawTarget) {
  const target = String(rawTarget).trim();

  if (!target) {
    throw new Error(
      "PNDS_OSC_TARGET cannot be empty.",
    );
  }

  let host;
  let portText;

  // IPv6: [::1]:57110
  if (target.startsWith("[")) {
    const closingBracket =
      target.indexOf("]");

    if (
      closingBracket < 0 ||
      target[closingBracket + 1] !== ":"
    ) {
      throw new Error(
        `Invalid OSC target '${target}'. ` +
          "Expected [ipv6-host]:port.",
      );
    }

    host = target.slice(
      1,
      closingBracket,
    );

    portText = target.slice(
      closingBracket + 2,
    );
  } else {
    const separatorIndex =
      target.lastIndexOf(":");

    if (separatorIndex <= 0) {
      throw new Error(
        `Invalid OSC target '${target}'. ` +
          "Expected host:port.",
      );
    }

    host = target.slice(
      0,
      separatorIndex,
    );

    portText = target.slice(
      separatorIndex + 1,
    );
  }

  const port = Number(portText);

  if (!host) {
    throw new Error(
      `Invalid OSC target '${target}': host is empty.`,
    );
  }

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      `Invalid OSC target '${target}': ` +
        "port must be an integer from 1 to 65535.",
    );
  }

  return {
    host,
    port,
    display: target,
  };
}

function resolveServerConfig(currentManifest) {
  const scoreServer =
    currentManifest.scoreServer || {};

  const performerPort = parseHttpPort(
    scoreServer.performerPort,
    "scoreServer.performerPort",
  );

  const monitorPort = parseHttpPort(
    scoreServer.monitorPort,
    "scoreServer.monitorPort",
  );

  if (performerPort === monitorPort) {
    throw new Error(
      "scoreServer.performerPort and " +
        "scoreServer.monitorPort must be different.",
    );
  }

  return {
    performerPort,
    monitorPort,
  };
}

function parseHttpPort(value, fieldName) {
  const port = Number(value);

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      `${fieldName} must be an integer from 1 to 65535.`,
    );
  }

  return port;
}

function formatAudioMode(mode) {
  return {
    internal: "Internal Synth",
    external: "External Synth",
    none: "No Synth",
  }[mode] || mode;
}


// ============================================================
// Runtime information
// ============================================================

function printRuntimeInfo() {
  console.log(
    `Audio mode: ${formatAudioMode(audioMode)} (${audioMode})`,
  );

  console.log(
    `OSC target: ${
      oscTarget
        ? oscTarget.display
        : "disabled"
    }`,
  );

  console.log(
    `Performer server: http://<ip>:${serverConfig.performerPort}`,
  );

  console.log(
    `Monitor server: http://<ip>:${serverConfig.monitorPort}`,
  );

  if (audioStartupError) {
    console.log(
      "[audio] startup error was recorded; " +
        "audio events will be skipped.",
    );
  }
}

function findLanIpv4Addresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();

  for (const networkInterface of Object.values(interfaces)) {
    for (const address of networkInterface || []) {
      if (address.family === "IPv4" && !address.internal) {
        addresses.push(address.address);
      }
    }
  }

  return addresses;
}

function resolveHostLanIp() {
  const configured = process.env.PNDS_HOST_IP?.trim();

  if (configured) {
    if (!net.isIPv4(configured)) {
      throw new Error(
        "PNDS_HOST_IP must be an IPv4 address without a port.",
      );
    }

    return configured;
  }

  return findLanIpv4Addresses()[0] || "127.0.0.1";
}

function getPerformerUrl() {
  return (
    `http://${hostLanIp}:` +
    `${serverConfig.performerPort}/`
  );
}


// ============================================================
// QR code
// ============================================================
//
// 无论从 performer 端口还是 monitor 端口访问 /qr，
// 都使用启动时确定的 performer LAN URL，而非浏览器请求的 Host。
// ============================================================

function printServerInfo() {
  const url = getPerformerUrl();

  console.log("Performer address: " + url);

  qrcode.generate(
    url,
    { small: true },
  );
}

const qrHandler = (request, response) => {
  const url = getPerformerUrl();

  QRCode.toString(
    url,
    {
      type: "svg",
      width: 6,
      margin: 1,
    },
    (error, svg) => {
      if (error) {
        response
          .status(500)
          .send("Error generating QR code");

        return;
      }

      response.type("image/svg+xml");
      response.send(svg);
    },
  );
};

app.get("/qr", qrHandler);
obApp.get("/qr", qrHandler);


// ============================================================
// Player state
// ============================================================

let nextTempId = 1;
const assignedIds = new Set();

function isPlayerId(value) {
  return VALID_PLAYER_IDS.has(
    String(value),
  );
}

function broadcastClientCount() {
  let count = 0;

  for (
    const sock of io.sockets.sockets.values()
  ) {
    if (
      sock.userType &&
      sock.userType !== "0"
    ) {
      count += 1;
    }
  }

  io.emit("clientCount", count);
}

// The monitor displays the score's existing OSC-shaped controls. These are
// semantic control messages: Internal mode maps them to /n_set, while
// External mode sends the same addresses to the project's debug bridge.
function broadcastOscActivity(address, values) {
  const payload = {
    address,
    values,
  };

  for (const sock of io.sockets.sockets.values()) {
    if (sock.userType === "0") {
      sock.emit("oscActivity", payload);
    }
  }
}


// ============================================================
// Socket.IO
// ============================================================

io.on("connection", (socket) => {
  // 分配临时 session ID。
  // 选择 Player 后会改成 1、2 或 3。
  socket.clientId = nextTempId++;

  socket.emit(
    "clientId",
    socket.clientId,
  );

  broadcastClientCount();


  // ----------------------------------------------------------
  // Player ID selection
  // ----------------------------------------------------------

  socket.on("selectId", (data) => {
    const userType =
      data && data.userType !== undefined
        ? String(data.userType)
        : null;

    if (
      userType !== "0" &&
      !isPlayerId(userType)
    ) {
      socket.emit("idConfirmation", {
        status: "rejected",
        userType,
        message: "Invalid player ID.",
      });

      return;
    }

    if (
      userType !== "0" &&
      assignedIds.has(userType)
    ) {
      socket.emit("idConfirmation", {
        status: "rejected",
        userType,
        message: "ID already taken",
      });

      return;
    }

    if (
      socket.userType &&
      socket.userType !== "0"
    ) {
      assignedIds.delete(
        socket.userType,
      );
    }

    socket.userType = userType;

    if (userType !== "0") {
      assignedIds.add(userType);
      socket.clientId = parseInt(
        userType,
        10,
      );
    }

    socket.emit("idConfirmation", {
      status: "accepted",
      userType,
    });

    if (userType !== "0") {
      socket.emit(
        "clientId",
        socket.clientId,
      );

      broadcastClientCount();
    }
  });


  // ----------------------------------------------------------
  // Point event
  // ----------------------------------------------------------

  socket.on("point", (data) => {
    if (!isPlayerId(socket.userType)) {
      return;
    }

    const playerId = Number(
      socket.userType,
    );

    const isActive = !(
      Array.isArray(data) &&
      data.length === 0
    );


    // --------------------------------------------------------
    // Broadcast point data to other browsers
    // --------------------------------------------------------

    if (!isActive) {
      socket.broadcast.emit("pointSend", {
        clear: true,
        clientId: playerId,
      });
    } else if (data && data.main) {
      socket.broadcast.emit("pointSend", {
        clientId: playerId,
        main: data.main,
        amp: data.amp,
      });
    }


    // --------------------------------------------------------
    // Cancel pending release retries
    // --------------------------------------------------------

    if (socket._releaseRetry) {
      clearTimeout(socket._releaseRetry);
      socket._releaseRetry = null;
    }


    // --------------------------------------------------------
    // Gate
    // --------------------------------------------------------

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

        dispatchAudio(
          `player ${playerId} gate on`,
          () =>
            audioController.setPlayerGate(
              playerId,
              1,
            ),
        );

        socket.pSendCount += 1;
      }
    } else {
      socket.lastPVal = 0;
      socket.pSendCount = 0;

      const sendRelease = () => {
        broadcastOscActivity(`/p${playerId}`, [0]);

        dispatchAudio(
          `player ${playerId} release`,
          () =>
            audioController.releasePlayer(
              playerId,
            ),
        );

        socket.pSendCount += 1;

        if (socket.pSendCount < 3) {
          socket._releaseRetry = setTimeout(
            sendRelease,
            50,
          );
        } else {
          socket._releaseRetry = null;
        }
      };

      sendRelease();
    }


    // --------------------------------------------------------
    // Position data
    //
    // data.relX → x
    // data.relY → y
    // data.amp  → 每个声部的 PitchShift 变调量
    //
    // Internal 与 External 都保留这套既有作品控制语义。
    // --------------------------------------------------------

    if (socket.lastXY === undefined) {
      socket.lastXY = {
        relX: null,
        relY: null,
        amp: null,
      };
    }

    if (
      isActive &&
      data &&
      data.main
    ) {
      const relX =
        data.relX !== undefined
          ? Number(data.relX)
          : 0.5;

      const relY =
        data.relY !== undefined
          ? Number(data.relY)
          : 0.5;

      const rawAmp =
        data.amp &&
        Number.isFinite(
          Number(data.amp.length),
        )
          ? Number(data.amp.length)
          : 0;

      const amp = Math.max(
        0,
        Math.min(1, rawAmp),
      );

      const last = socket.lastXY;

      const changed =
        relX !== last.relX ||
        relY !== last.relY ||
        amp !== last.amp;

      if (changed) {
        socket.lastXY = {
          relX,
          relY,
          amp,
        };

        broadcastOscActivity(
          `/p${playerId}xy`,
          [relX, relY, amp],
        );

        dispatchAudio(
          `player ${playerId} position`,
          () =>
            audioController.setPlayerPosition(
              playerId,
              {
                x: relX,
                y: relY,
                amp,
              },
            ),
        );
      }
    } else if (!isActive) {
      socket.lastXY = {
        relX: null,
        relY: null,
        amp: null,
      };
    }
  });


  // ----------------------------------------------------------
  // Line stroke
  // ----------------------------------------------------------

  socket.on("lineStroke", (data) => {
    if (!isPlayerId(socket.userType)) {
      return;
    }

    if (
      !data ||
      typeof data.id !== "string"
    ) {
      console.warn(
        "[audio] ignoring invalid lineStroke:",
        data,
      );

      return;
    }

    const stroke = Number(
      data.stroke,
    );

    if (!Number.isFinite(stroke)) {
      console.warn(
        "[audio] ignoring invalid line stroke value:",
        data,
      );

      return;
    }

    broadcastOscActivity(`/${data.id}`, [stroke]);

    dispatchAudio(
      `line ${data.id}`,
      () =>
        audioController.setPairStroke(
          data.id,
          stroke,
        ),
    );
  });


  // ----------------------------------------------------------
  // Disconnect
  // ----------------------------------------------------------

  socket.on("disconnect", () => {
    if (isShuttingDown) {
      if (socket._releaseRetry) {
        clearTimeout(socket._releaseRetry);
        socket._releaseRetry = null;
      }

      return;
    }

    const isPlayer =
      isPlayerId(socket.userType);

    if (isPlayer) {
      const playerId = Number(
        socket.userType,
      );

      broadcastOscActivity(`/p${playerId}`, [0]);

      dispatchAudio(
        `player ${playerId} disconnect`,
        () =>
          audioController.releasePlayer(
            playerId,
          ),
      );

      socket.broadcast.emit("pointSend", {
        clear: true,
        clientId: playerId,
      });

      assignedIds.delete(
        socket.userType,
      );
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


// ============================================================
// Graceful shutdown
// ============================================================

function clearReleaseRetries() {
  for (const socket of io.sockets.sockets.values()) {
    if (socket._releaseRetry) {
      clearTimeout(socket._releaseRetry);
      socket._releaseRetry = null;
    }
  }
}

function closeHttpServer(httpServer, label) {
  return new Promise((resolve) => {
    httpServer.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        console.error(`[shutdown] failed to close ${label}:`, error);
        process.exitCode = 1;
      }

      resolve();
    });
  });
}

function closeSocketIo() {
  return new Promise((resolve) => {
    io.close(resolve);
  });
}

function shutdown(signal) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  isShuttingDown = true;
  console.log(`[shutdown] received ${signal}.`);

  shutdownPromise = (async () => {
    clearReleaseRetries();
    await closeSocketIo();
    await audioReady;

    try {
      await audioController.stop();
    } catch (error) {
      console.error("[shutdown] failed to stop audio:", error);
      process.exitCode = 1;
    }

    await Promise.all([
      closeHttpServer(server, "performer HTTP server"),
      closeHttpServer(monitorServer, "monitor HTTP server"),
    ]);

    console.log("[shutdown] complete.");
  })().catch((error) => {
    console.error("[shutdown] failed:", error);
    process.exitCode = 1;
  });

  return shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
