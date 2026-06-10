let socket;
let ID; // Client Browser ID
let clientCount = 0; // Store total client count
let userType = null; // Can be "1", "2", "3" or "0" (0 = OB observer)
let selectionMade = false; // Flag to track if user has selected ID

let localPoint; // Local touch point
let remotePoints = {};
let activeLines = {}; // added global variable for tracking active line connections
let qrVisible = false; // QR code visibility state
let pointFrameCount = 0; // throttle: emit point every 2 frames
let maxLineLength = 300;
const colors = ["#000000", "#14213d", "#515E63", "#e5e5e5", "#ffffff"];
const { pow } = Math;

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

    // "0" is a hidden option for the operator (former "OB", not shown in prompt text)
    const validSelection = ["1", "2", "3", "0"].includes(selection);

    if (validSelection) {
      // Send selection to server
      socket.emit("selectId", { userType: selection });
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

  const hostname = window.location.hostname;
  socket = io.connect(`http://${hostname}:6868`);

  // --- Connection status UI ---
  socket.on("connect", () => {
    updateConnStatus("connected", "Connected");
  });
  socket.on("disconnect", () => {
    updateConnStatus("disconnected", "Disconnected");
  });
  if (socket.io) {
    socket.io.on("reconnect_attempt", () => {
      updateConnStatus("reconnecting", "Reconnecting...");
    });
    socket.io.on("reconnect", () => {
      updateConnStatus("connected", "Reconnected");
    });
  }
  // --- End connection status UI ---

  socket.on("pointSend", (data) => {
    if (data.clear) {
      delete remotePoints[data.clientId];
    } else if (data && data.main) {
      remotePoints[data.clientId] = {
        main: createVector(data.main.x + width / 2, data.main.y + height / 2),
        amp: data.amp
          ? {
              x: data.amp.x + width / 2,
              y: data.amp.y + height / 2,
              length: data.amp.length,
            }
          : null,
      };
    }
  });

  socket.on("clientId", (clientId) => {
    ID = clientId;
    // When we get client ID, prompt for user type
    if (!selectionMade) {
      promptForUserType();
    }
  });

  // Add listener for client count updates
  socket.on("clientCount", (count) => {
    clientCount = count;
    document.getElementById("badge-clients-text").textContent = count;
  });

  // Listen for ID selection confirmation
  socket.on("idConfirmation", (data) => {
    if (data.status === "accepted") {
      userType = data.userType;
      selectionMade = true;

      // Show badge for players only (operator (0) doesn't need it)
      if (userType !== "0") {
        document.getElementById("badge-user-text").textContent = userType;
        document.getElementById("badge-user").classList.add("visible");
      }
      document.getElementById("badge-clients").classList.add("visible");

      // Show QR toggle button in operator mode (projected on big screen)
      const qrToggle = document.getElementById("qr-toggle");
      if (userType === "0") {
        qrToggle.classList.add("visible");
        // Auto-show QR code on the operator screen for players to scan
        showQR();
      } else {
        // Players 1/2/3 don't need the QR code or toggle on their devices
        qrToggle.classList.remove("visible");
        hideQR();
      }
    } else {
      // ID already taken, user needs to select again
      alert(`ID ${data.userType} is already taken. Please select another.`);
      selectionMade = false;
      userType = null;
      document.getElementById("badge-user-text").textContent = "—";
      document.getElementById("badge-user").classList.remove("visible");
      document.getElementById("badge-clients").classList.remove("visible");
      promptForUserType();
    }
  });

  // QR toggle button click handler
  document.getElementById("qr-toggle").addEventListener("click", () => {
    if (qrVisible) {
      hideQR();
    } else {
      showQR();
    }
  });

  // Clicking the QR code itself also hides it
  document.getElementById("qr-wrapper").addEventListener("click", () => {
    if (qrVisible) hideQR();
  });
}

function showQR() {
  qrVisible = true;
  document.getElementById("qr-overlay").classList.add("visible");
  document.getElementById("qr-toggle").classList.add("active");
  document.getElementById("qr-toggle-icon").textContent = "\u2B07"; // down arrow when visible
}

function hideQR() {
  qrVisible = false;
  document.getElementById("qr-overlay").classList.remove("visible");
  document.getElementById("qr-toggle").classList.remove("active");
  document.getElementById("qr-toggle-icon").textContent = "\u2B06"; // up arrow when hidden
}

function updateConnStatus(state, text) {
  const el = document.getElementById("connection-status");
  const textEl = document.getElementById("status-text");
  el.className = "visible " + state;
  textEl.textContent = text;
  // Auto-hide after 2s when connected
  if (state === "connected") {
    setTimeout(() => {
      el.className = "hidden " + state;
    }, 2000);
  }
}

let touchReleasedSent = false; // Flag to track if 0 has been sent

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
      socket.volatile.emit("point", data);
    }
  } else if (userType !== "0") {
    localPoint = undefined;
    if (!touchReleasedSent) {
      socket.volatile.emit("point", []); // Send 0 only once
      touchReleasedSent = true; // Set flag to prevent repeated sends
    }
  }

  fill(colors[2]);
  // Draw remote points with ID label for operator mode
  for (let key in remotePoints) {
    const ptData = remotePoints[key];
    let diameter = ptData.amp ? 20 + ptData.amp.length * 60 : 20;
    circle(ptData.main.x, ptData.main.y, diameter);
    if (ptData.amp) {
      circle(ptData.amp.x, ptData.amp.y, 12);
    }
    if (userType === "0") {
      textAlign(RIGHT, TOP);
      fill(colors[4]);
      textSize(12);
      text(
        `🎹 ${key}`,
        ptData.main.x + diameter * 1.5,
        ptData.main.y - diameter * 1.5,
      );
    }
  }

  // Build array with { id, pt } for local and remote points.
  const points = [];
  if (localPoint && userType !== "0") points.push({ id: ID, pt: localPoint });
  // Map remotePoints: key is remote client id.
  for (const [key, dp] of Object.entries(remotePoints)) {
    points.push({ id: key, pt: dp.main });
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
            socket.volatile.emit("lineStroke", { id: lineId, stroke: sw });
            newActiveLines[lineId] = true;
          } else {
            socket.volatile.emit("lineStroke", { id: lineId, stroke: 0 });
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
        socket.volatile.emit("lineStroke", { id: id, stroke: 0 });
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
  } else if (userType === "0") {
  }
}
