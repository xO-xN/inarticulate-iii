const IS_OPERATOR = location.port === String(window.PNDS.monitorPort);
const P = window.PNDS;
const STORAGE = P.storageKeys;
const EVENTS = P.events;

let socket;
let ID; // Client Browser ID
let clientCount = 0; // Store total client count
let userType = IS_OPERATOR ? "0" : readStoredPlayerId();
let selectionMade = false; // Confirmed by the current server connection
let performerClaimToken = IS_OPERATOR ? null : getClaimToken();
let hasConnectedOnce = false;
let connectionStatusTimeout = null;

let localPoint; // Local touch point
let remotePoints = {};
let qrVisible = false;
let activeLines = {}; // added global variable for tracking active line connections
let pointFrameCount = 0; // throttle: emit point every 2 frames
let maxLineLength = 300;
const colors = ["#000000", "#14213d", "#515E63", "#e5e5e5", "#ffffff"];
const { pow } = Math;

function readStoredPlayerId() {
  try {
    const playerId = localStorage.getItem(STORAGE.playerId);

    return P.playerIds.includes(playerId) ? playerId : null;
  } catch {
    return null;
  }
}

function getClaimToken() {
  try {
    const stored = localStorage.getItem(STORAGE.playerClaim);

    if (stored) {
      return stored;
    }

    const token = crypto.randomUUID
      ? crypto.randomUUID()
      : createClaimToken();

    localStorage.setItem(STORAGE.playerClaim, token);
    return token;
  } catch {
    return null;
  }
}

function createClaimToken() {
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);

  return Array.from(values, (value) =>
    value.toString(16).padStart(8, "0"),
  ).join("");
}

function persistPlayerId(playerId) {
  try {
    localStorage.setItem(STORAGE.playerId, playerId);
  } catch {
    // The current connection can still work when browser storage is blocked.
  }
}

function clearStoredPlayerId() {
  try {
    localStorage.removeItem(STORAGE.playerId);
  } catch {
    // The current connection can still continue after a rejected claim.
  }
}

function selectPlayer(playerId) {
  socket.emit(EVENTS.selectId, {
    userType: playerId,
    claimToken: performerClaimToken,
  });
}

// Use native Safari action sheet (prompt/alert)
function promptForUserType() {
  // Using setTimeout to ensure this runs after the page has loaded
  setTimeout(() => {
    const selection = prompt("Select your 🎹:", "1, 2 or 3");

    if (selection === null) {
      // User canceled - ask again
      promptForUserType();
      return;
    }

    const validSelection = P.playerIds.includes(selection);

    if (validSelection) {
      selectPlayer(selection);
    } else {
      // Invalid selection, prompt again
      alert("Please enter a valid option: 1, 2 or 3");
      promptForUserType();
    }
  }, 300);
}

function preload() {
  p1c = loadImage("/assets/p1curve.png");
  p2c = loadImage("/assets/p2curve.png");
  p3c = loadImage("/assets/p3curve.png");
}

function setup() {
  // iOS fullscreen: hide Safari address bar on load
  window.scrollTo(0, 1);

  createCanvas(windowWidth, windowHeight);
  frameRate(60);

  if (IS_OPERATOR) {
    document.body.classList.add("monitor-mode");
  }

  const hostname = window.location.hostname;
  socket = io.connect(`http://${hostname}:${P.performerPort}`);

  // --- Connection status UI ---
  socket.on("connect", () => {
    updateConnStatus(
      "connected",
      hasConnectedOnce ? "Reconnected" : "Connected",
    );
    hasConnectedOnce = true;

    if (IS_OPERATOR) {
      socket.emit(EVENTS.selectId, { userType: "0" });
      showQR();
      return;
    }

    // Socket.IO assigns a new server-side socket after a mobile browser
    // reconnects. Restore the previously accepted performer ID so the
    // server continues to accept this client's point and line events.
    if (userType) {
      selectPlayer(userType);
    }
  });
  socket.on("disconnect", () => {
    updateConnStatus("disconnected", "Disconnected");
  });
  if (socket.io) {
    socket.io.on("reconnect_attempt", () => {
      updateConnStatus("reconnecting", "Reconnecting...");
    });

  }
  // --- End connection status UI ---

  socket.on(EVENTS.pointSend, (data) => {
    if (data.clear) {
      delete remotePoints[data.clientId];
    } else if (data && data.main) {
      remotePoints[data.clientId] = {
        main: { x: data.main.x, y: data.main.y },
        amp: data.amp
          ? {
              x: data.amp.x,
              y: data.amp.y,
              length: data.amp.length,
            }
          : null,
      };
    }
  });

  socket.on(EVENTS.clientId, (clientId) => {
    ID = clientId;
    // A stored player ID is claimed immediately on connect. Only prompt
    // when this browser has neither a confirmed nor a stored selection.
    if (!selectionMade && !IS_OPERATOR && !userType) {
      promptForUserType();
    }
  });

  // Add listener for client count updates
  socket.on(EVENTS.clientCount, (count) => {
    clientCount = count;
    document.getElementById("badge-clients-text").textContent = count;
  });

  socket.on(EVENTS.oscActivity, (data) => {
    if (IS_OPERATOR) {
      updateOscActivity(data);
    }
  });

  	// Listen for ID selection confirmation
  	socket.on(EVENTS.idConfirmation, (data) => {
  		if (data.status === "accepted") {
  			userType = data.userType;
  			selectionMade = true;

  			if (!IS_OPERATOR) {
  				persistPlayerId(userType);
  			}

  			// Show badge for players only (operator (0) doesn't need it)
  			if (userType !== "0") {
  				document.getElementById("badge-user-text").textContent = userType;
  				document.getElementById("badge-user").classList.add("visible");
  			}
  			document.getElementById("badge-clients").classList.add("visible");
  		} else {
  			// ID already taken, user needs to select again
  			alert(`ID ${data.userType} is already taken. Please select another.`);
  			selectionMade = false;
  			userType = null;
  			clearStoredPlayerId();
  			document.getElementById("badge-user-text").textContent = "—";
  			document.getElementById("badge-user").classList.remove("visible");
  			document.getElementById("badge-clients").classList.remove("visible");
  			if (!IS_OPERATOR) promptForUserType();
  		}
  	});

  	// Operator-triggered role reset: clear local identity and re-prompt.
  	socket.on(EVENTS.rolesReset, () => {
  		if (!IS_OPERATOR) {
  			selectionMade = false;
  			userType = null;
  			clearStoredPlayerId();
  			document.getElementById("badge-user-text").textContent = "—";
  			document.getElementById("badge-user").classList.remove("visible");
  			document.getElementById("badge-clients").classList.remove("visible");
  			promptForUserType();
  		}
  	});

  if (IS_OPERATOR) {
    document.getElementById("qr-toggle").addEventListener("click", () => {
      if (qrVisible) hideQR();
      else showQR();
    });
    document.getElementById("qr-wrapper").addEventListener("click", () => {
      if (qrVisible) hideQR();
    });
    document.addEventListener("keydown", (event) => {
      if (event.code === "Space") {
        event.preventDefault();
        if (qrVisible) hideQR();
        else showQR();
      }
    });
    document.getElementById("reset-roles").addEventListener("click", () => {
      socket.emit(EVENTS.resetRoles);
    });
  }
}

function updateConnStatus(state, text) {
  const el = document.getElementById("connection-status");
  const textEl = document.getElementById("status-text");

  if (connectionStatusTimeout) {
    clearTimeout(connectionStatusTimeout);
    connectionStatusTimeout = null;
  }

  el.className = "visible " + state;
  textEl.textContent = text;

  // Only a stable connection is transient. A previous success timer must
  // never hide a later disconnected or reconnecting status.
  if (state === "connected") {
    connectionStatusTimeout = setTimeout(() => {
      el.className = "hidden " + state;
      connectionStatusTimeout = null;
    }, 2000);
  }
}

function updateOscActivity(data) {
  if (!data || typeof data.address !== "string") {
    return;
  }

  const row = document.querySelector(
    `[data-osc-address="${data.address}"]`,
  );

  if (!row) {
    return;
  }

  const values = Array.isArray(data.values) ? data.values : [];
  const formatted = values.map((value) => {
    const number = Number(value);

    return Number.isFinite(number)
      ? number.toFixed(3)
      : String(value);
  });

  row.querySelector("output").textContent = formatted.join(", ");
  row.classList.remove("updated");
  void row.offsetWidth;
  row.classList.add("updated");

  setTimeout(() => {
    row.classList.remove("updated");
  }, 220);
}

function showQR() {
  qrVisible = true;
  document.getElementById("qr-overlay").classList.add("visible");
  document.getElementById("qr-toggle").classList.add("active");
  document.getElementById("qr-toggle-icon").textContent = "\u2B07";
}
function hideQR() {
  qrVisible = false;
  document.getElementById("qr-overlay").classList.remove("visible");
  document.getElementById("qr-toggle").classList.remove("active");
  document.getElementById("qr-toggle-icon").textContent = "\u2B06";
}

let touchReleasedSent = false; // Flag to track if 0 has been sent

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function toCanvasPoint(point) {
  return createVector(point.x + width / 2, point.y + height / 2);
}

function draw() {
  background(colors[0]);

  // Return early if no selection made
  if (!selectionMade) {
    return;
  }

  // Draw the normal interface once ID is selected
  for (let i = 0; i < 24; i++) {
    noFill();
    // Calculate alpha based on circle index (fading as i increases)
    const alpha = map(i, 0, 23, 255, 30); // Map from fully opaque to mostly transparent
    const c = color(colors[3]);
    c.setAlpha(alpha);
    stroke(c);
    strokeWeight(0.5);
    let size = 80 + pow(i, 4) / 50;
    circle(width / 2, height / 2, size);
  }

  // Show badges when selection is made
  if (selectionMade) {
    if (userType !== "0") {
      document.getElementById("badge-user").classList.add("visible");
    }
    document.getElementById("badge-clients").classList.add("visible");
  }

  drawNotes();

  fill(colors[3]);
  noStroke();

  // Only process touch inputs if not in observer mode
  if (userType !== "0" && touches.length) {
    touchReleasedSent = false; // Reset flag when touch is detected
    const pt = touches[0]; // first touch for main point
    localPoint = createVector(pt.x, pt.y);
    const cp = createVector(pt.x - width / 2, pt.y - height / 2);
    // Build data with main point info
    let data = { main: { x: cp.x, y: cp.y } };
    // 修改后的 normalized 值：中点为0.5，向右和向上增大，向左和向下减小，并限制在[0,1]
    data.relX = constrain(map(pt.x, 0, width, 0, 1), 0, 1);
    data.relY = constrain(map(pt.y, height, 0, 0, 1), 0, 1);

    // if second touch exists, include amp data and draw locally as before
    if (touches.length > 1) {
      const ampPoint = touches[1]; // second touch for amplitude
      const ampVec = createVector(
        ampPoint.x - width / 2,
        ampPoint.y - height / 2,
      );
      const ampLength = map(
        p5.Vector.dist(localPoint, createVector(ampPoint.x, ampPoint.y)),
        0,
        (width + height) * 0.7,
        0,
        1,
      );
      data.amp = { x: ampVec.x, y: ampVec.y, length: ampLength };

      // Local drawing for amplitude effect
      circle(ampPoint.x, ampPoint.y, 12);
      circle(pt.x, pt.y, 20 + ampLength * 60);
    }
    // Local drawing for main touch (every frame for smoothness)
    circle(pt.x, pt.y, 20);

    // Throttle: emit point data every 2 frames (~30fps) to reduce WiFi load
    pointFrameCount++;
    if (pointFrameCount % 2 === 0) {
      socket.volatile.emit(EVENTS.point, data);
    }
  } else if (userType !== "0") {
    localPoint = undefined;
    if (!touchReleasedSent) {
      socket.volatile.emit(EVENTS.point, []); // Send 0 only once
      touchReleasedSent = true; // Set flag to prevent repeated sends
    }
  }

  fill(colors[2]);
  // Draw remote points with ID label for operator mode
  for (let key in remotePoints) {
    const ptData = remotePoints[key];
    const mainPoint = toCanvasPoint(ptData.main);
    const ampPoint = ptData.amp ? toCanvasPoint(ptData.amp) : null;
    let diameter = ptData.amp ? 20 + ptData.amp.length * 60 : 20;
    circle(mainPoint.x, mainPoint.y, diameter);
    if (ampPoint) {
      circle(ampPoint.x, ampPoint.y, 12);
    }
    textAlign(RIGHT, TOP);
    fill(colors[4]);
    textSize(12);
    text(
      `🎹 ${key}`,
      mainPoint.x + diameter * 1.5,
      mainPoint.y - diameter * 1.5,
    );
  }

  // Build array with { id, pt } for local and remote points.
  const points = [];
  if (localPoint && userType !== "0") points.push({ id: ID, pt: localPoint });
  // Map remotePoints: key is remote client id.
  for (const [key, dp] of Object.entries(remotePoints)) {
    points.push({ id: key, pt: toCanvasPoint(dp.main) });
  }

  // Connect points among points; only emit event if one point is local.
  let newActiveLines = {};
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      let dst = p5.Vector.dist(points[i].pt, points[j].pt);
      let sw = map(dst, 0, maxLineLength, 1, 0);
      let lineId = "";

      if (userType !== "0") {
        if (points[i].id == ID && points[j].id != ID) {
          lineId = `p${points[i].id}-p${points[j].id}`;
        } else if (points[j].id == ID && points[i].id != ID) {
          lineId = `p${points[j].id}-p${points[i].id}`;
        }

        if (lineId) {
          if (dst < maxLineLength) {
            socket.volatile.emit(EVENTS.lineStroke, { id: lineId, stroke: sw });
            newActiveLines[lineId] = true;
          } else {
            socket.volatile.emit(EVENTS.lineStroke, { id: lineId, stroke: 0 });
          }
        }
      }

      if (dst < maxLineLength) {
        connect(points[i].pt, points[j].pt, sw);
      }
    }
  }

  noStroke();
  fill(colors[0]);
  circle(width / 2, height / 2, 75);

  // When a previously active line is no longer present, emit stroke 0.
  if (userType !== "0") {
    for (let id in activeLines) {
      if (!newActiveLines[id]) {
        socket.volatile.emit(EVENTS.lineStroke, { id: id, stroke: 0 });
      }
    }
    activeLines = newActiveLines;
  }
}

function connect(p1, p2, sw) {
  push();
  stroke(colors[3]);
  strokeWeight(sw * 5);
  line(p1.x, p1.y, p2.x, p2.y);
  pop();
}

function drawNotes() {
  imageMode(CENTER);
  stroke(colors[3]);

  if (userType === "1") {
    image(p1c, width / 2, height / 2, width, (width * 5) / 3);
  } else if (userType === "2") {
    image(p2c, width / 2, height / 2, width, (width * 5) / 3);
  } else if (userType === "3") {
    image(p3c, width / 2, height / 2, width, (width * 5) / 3);
  }
}
