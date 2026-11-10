// Controlled real-browser acceptance; no audio device or App dev server needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  "shared-root": { type: "string" },
  "playwright-module": { type: "string" },
  "browser-executable": { type: "string" },
  project: { type: "string", default: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") },
  screenshot: { type: "string" },
} });
for (const name of ["shared-root", "playwright-module", "browser-executable"]) {
  assert.ok(values[name], `Required: --${name}`);
}
const { chromium } = await import(pathToFileURL(path.resolve(values["playwright-module"])).href);
const { io } = createRequire(import.meta.url)("socket.io-client");
const catalog = JSON.parse(fs.readFileSync(path.join(values["shared-root"], "catalog.json")));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "iii-shared-browser-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, message, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await delay(25);
  }
}
async function port() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const force = setTimeout(() => child.kill("SIGKILL"), 2000);
  child.kill("SIGTERM");
  const [code] = await exited;
  clearTimeout(force);
  assert.equal(code, 0, "graceful score shutdown");
}

let browser;
const children = [];
const contexts = [];
const observers = [];
const udp = dgram.createSocket("udp4");
const packets = [];
udp.on("message", bytes => packets.push(bytes.toString("hex")));
udp.bind(0, "127.0.0.1");
await once(udp, "listening");
let proxy;
const proxySockets = new Set();
const errors = [];
const blocked = [];
const evidence = [];
try {
  for (const name of ["server.js", "lib", "audio", "public", "supercollider", "manifest.json", "package.json"]) {
    fs.cpSync(path.join(values.project, name), path.join(temporary, name), { recursive: true });
  }
  assert.ok(!fs.existsSync(path.join(temporary, "node_modules")));
  const manifest = JSON.parse(fs.readFileSync(path.join(temporary, "manifest.json")));
  manifest.scoreServer.performerPort = await port();
  manifest.scoreServer.monitorPort = await port();
  fs.writeFileSync(path.join(temporary, "manifest.json"), JSON.stringify(manifest));
  const resolved = Object.fromEntries(manifest.sharedLibraries.map(ref => {
    const item = catalog.libraries.find(item => item.id === ref.id && item.version === ref.version);
    assert.ok(item, `${ref.id}@${ref.version} missing`);
    return [item.id, { version: item.version, kind: item.kind,
      path: path.resolve(values["shared-root"], item.entry),
      ...(item.browserEntry ? { browserPath: path.resolve(values["shared-root"], item.browserEntry) } : {}),
    }];
  }));
  const origin = `http://127.0.0.1:${manifest.scoreServer.performerPort}`;
  const monitor = `http://127.0.0.1:${manifest.scoreServer.monitorPort}`;

  // This certificate tests the browser's HTTPS/WSS path, not venue trust or DNS.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", path.join(temporary, "key.pem"), "-out", path.join(temporary, "cert.pem"),
    "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  proxy = https.createServer({ key: fs.readFileSync(path.join(temporary, "key.pem")),
    cert: fs.readFileSync(path.join(temporary, "cert.pem")) }, (request, response) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: manifest.scoreServer.performerPort,
      method: request.method, path: request.url, headers: request.headers }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.on("error", () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  proxy.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(manifest.scoreServer.performerPort, "127.0.0.1", () => {
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` +
        Object.entries(request.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("") + "\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  proxy.on("connection", socket => {
    proxySockets.add(socket);
    socket.on("close", () => proxySockets.delete(socket));
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const secureOrigin = `https://127.0.0.1:${proxy.address().port}`;
  const performerUrl = `${secureOrigin}/?venue=iii`;
  async function start(mode) {
    let output = "";
    const child = spawn(process.execPath, [path.join(temporary, "server.js"), "--audio-mode", mode], {
      env: { ...process.env, PNDS_HOST_IP: "127.0.0.1", PNDS_SHARED_LIBRARIES: JSON.stringify(resolved),
        PNDS_PERFORMER_URL: performerUrl, PNDS_OSC_TARGET: `127.0.0.1:${udp.address().port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout.on("data", bytes => output += bytes);
    child.stderr.on("data", bytes => output += bytes);
    const deadline = Date.now() + 8000;
    while (true) {
      try { if ((await (await fetch(`${origin}/__pnds/health`)).json()).status === "ready") break; } catch {}
      assert.ok(child.exitCode === null && Date.now() < deadline, output);
      await delay(25);
    }
    return child;
  }
  browser = await chromium.launch({ executablePath: values["browser-executable"], headless: true });
  async function pageFor(url, player, imageFailure = false) {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, hasTouch: true, ignoreHTTPSErrors: true });
    contexts.push(context);
    await context.route("**/*", route => {
      const target = new URL(route.request().url());
      if (target.hostname !== "127.0.0.1") { blocked.push(target.href); return route.abort(); }
      if (target.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
      return route.continue();
    });
    if (imageFailure) await context.route("**/assets/p2curve.png", route => route.fulfill({ status: 404 }));
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept(player));
    await page.addInitScript(() => {
      window.__drawnCurves = new WeakSet();
      const original = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(source, ...rest) {
        if (this.canvas.classList.contains("p5Canvas")) window.__drawnCurves.add(source);
        return original.call(this, source, ...rest);
      };
    });
    await page.goto(url);
    if (!imageFailure) await page.waitForFunction(expected => selectionMade && userType === expected &&
      p1c?.width > 0 && p2c?.width > 0 && p3c?.width > 0 && socket?.connected, player);
    return page;
  }
  async function observer() {
    const client = io(origin, { forceNew: true, reconnection: false });
    observers.push(client);
    const points = [], activity = [];
    client.on("pointSend", value => points.push(value));
    client.on("oscActivity", value => activity.push(value));
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    const claimed = once(client, "idConfirmation", { signal: AbortSignal.timeout(5000) });
    client.emit("selectId", { userType: "0" });
    assert.equal((await claimed)[0].status, "accepted");
    return { client, points, activity };
  }
  async function touches(page, watch, mode) {
    const session = await page.context().newCDPSession(page);
    const before = watch.points.length;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
      { id: 7, x: 200, y: 150 }, { id: 9, x: 600, y: 450 },
    ] });
    await until(() => watch.points.slice(before).some(value => value.amp), "two-touch point broadcast");
    const point = watch.points.slice(before).find(value => value.amp);
    assert.deepEqual(point.main, { x: -200, y: -150 });
    assert.equal(point.amp.x, 200); assert.equal(point.amp.y, 150);
    assert.ok(Math.abs(point.amp.length - 25 / 49) < 1e-8);
    await until(() => watch.activity.some(value => value.address === "/p1xy"), "monitor OSC activity");
    const activity = watch.activity.filter(value => value.address === "/p1xy").at(-1);
    assert.deepEqual(activity.values.slice(0, 2), [0.25, 0.75]);
    assert.ok(Math.abs(activity.values[2] - 25 / 49) < 1e-8);
    if (mode === "external") {
      // OSC 1.0 strings/tags + big-endian float32; independent of osc-min.
      await until(() => packets.includes("2f703178790000002c666666000000003e8000003f4000003f029cbc"), "actual /p1xy UDP bytes");
      assert.ok(packets.includes("2f7031002c6600003f800000"), "actual /p1 gate UDP bytes");
    }
    const released = watch.points.length;
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(() => watch.points.slice(released).some(value => value.clear), "release clears remote point");
    await session.detach();
  }

  async function nativeTouchEvents(page, watch) {
    const before = watch.points.length;
    const prevented = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const points = [
        new Touch({ identifier: 7, target: canvas, clientX: 200, clientY: 150 }),
        new Touch({ identifier: 9, target: canvas, clientX: 600, clientY: 450 }),
      ];
      const start = new TouchEvent("touchstart", { bubbles: true, cancelable: true,
        touches: points, targetTouches: points, changedTouches: points });
      canvas.dispatchEvent(start);
      return start.defaultPrevented;
    });
    assert.equal(prevented, true, "native touch suppresses selection and long-press callouts");
    await until(() => watch.points.slice(before).some(value => value.amp), "native TouchEvent reaches the actual p5 draw and socket path");
    const point = watch.points.slice(before).find(value => value.amp);
    assert.deepEqual(point.main, { x: -200, y: -150 });
    assert.equal(point.amp.x, 200);
    assert.equal(point.amp.y, 150);
    const released = watch.points.length;
    await page.evaluate(() => document.querySelector("canvas").dispatchEvent(new TouchEvent("touchcancel", {
      bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [],
    })));
    await until(() => watch.points.slice(released).some(value => value.clear), "native cancellation releases the remote point");
    const next = watch.points.length;
    await page.evaluate(() => document.querySelector("canvas").dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 17, pointerType: "touch", clientX: 200, clientY: 150, buttons: 1,
    })));
    await until(() => watch.points.slice(next).some(value => value.main), "a later pointer-only gesture reaches the same draw path");
    assert.deepEqual(watch.points.slice(next).find(value => value.main).main, { x: -200, y: -150 });
    const ended = watch.points.length;
    await page.evaluate(() => document.querySelector("canvas").dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 17, pointerType: "touch", clientX: 200, clientY: 150, buttons: 0,
    })));
    await until(() => watch.points.slice(ended).some(value => value.clear), "later pointer-only release clears the remote point");
  }

  let child = await start("none");
  let watch = await observer();
  const pages = [];
  for (const id of ["1", "2", "3"]) {
    const page = await pageFor(origin, id);
    pages.push(page);
    await page.waitForFunction(id => window.__drawnCurves.has([p1c, p2c, p3c][Number(id) - 1].canvas), id);
  }
  assert.equal(await pages[0].evaluate(() => p5.VERSION), "2.3.4");
  const saved = await pages[0].evaluate(() => [userType, performerClaimToken]);
  await touches(pages[0], watch, "none");
  await nativeTouchEvents(pages[0], watch);
  assert.equal(packets.length, 0, "None sends no UDP");
  await pages[0].reload();
  await pages[0].waitForFunction(() => socket?.connected && selectionMade && userType === "1");
  assert.deepEqual(await pages[0].evaluate(() => [userType, performerClaimToken]), saved);
  const oldSocket = await pages[0].evaluate(() => socket.id);
  await pages[0].evaluate(() => socket.io.engine.close());
  await pages[0].waitForFunction(previous => socket?.connected && socket.id !== previous && selectionMade && userType === "1", oldSocket);
  const venue = await pageFor(`${monitor}/?surface=venue`, "0");
  assert.ok(await venue.evaluate(() => IS_VENUE && document.body.classList.contains("venue-mode")));
  if (values.screenshot) await pages[0].screenshot({ path: values.screenshot });
  // Prove the route guard really blocks a request, not just that none happened.
  assert.equal(await pages[0].evaluate(async () => {
    try { await fetch("https://example.invalid/offline-probe"); return false; } catch { return true; }
  }), true);
  assert.equal(blocked.length, 1);
  const beforeRestart = await pages[0].evaluate(() => socket.id);
  watch.client.close();
  await stop(child);
  child = await start("none");
  watch = await observer();
  // Graceful server shutdown explicitly disconnects Socket.IO clients.
  // Reopen the score after restarting, preserving its accepted identity.
  await pages[0].reload();
  await pages[0].waitForFunction(previous => socket?.connected && socket.id !== previous &&
    selectionMade && userType === "1", beforeRestart);
  await touches(pages[0], watch, "none");
  evidence.push({ mode: "none", curvesDrawn: [1, 2, 3], twoTouches: true, nativeTouchEvents: true,
    nativeTouchDefaultPrevented: true, nativeCancelReleasesPoint: true, laterPointerOnlyInput: true, identityAfterReloadAndReconnect: true,
    identityAfterServerRestartAndReload: true, venue: true, noUdp: true, externalRequestBlocked: true });
  for (const context of contexts.splice(0)) await context.close();
  watch.client.close();
  await stop(child);

  child = await start("external");
  watch = await observer();
  const secure = await pageFor(performerUrl, "1");
  assert.equal(await secure.evaluate(() => window.__PNDS_CONFIG__.performerUrl), performerUrl);
  await secure.waitForFunction(() => socket.io.engine.transport.name === "websocket");
  assert.ok(await secure.evaluate(() => socket.io.engine.transport.ws.url.startsWith("wss://")));
  await touches(secure, watch, "external");
  evidence.push({ mode: "external", httpsSameOriginWss: true, fullPerformerUrl: performerUrl, twoTouches: true, exactOscUdp: true });
  await contexts.pop().close();
  watch.client.close();
  const failed = await pageFor(origin, "1", true);
  await failed.waitForFunction(() => document.getElementById("status-text").textContent.includes("images failed"));
  assert.ok(await failed.evaluate(() => !selectionMade && typeof socket === "undefined"));
  await failed.context().unroute("**/assets/p2curve.png");
  await failed.reload();
  await failed.waitForFunction(() => socket?.connected && selectionMade && userType === "1" && p2c.width > 0);
  evidence.push({ missingImage: "visible failure before control connection", recoveredAfterReload: true });
  assert.deepEqual(errors, [], "no uncaught browser errors");
  console.log(JSON.stringify({ project: manifest.id, version: manifest.version, p5: "2.3.4", noLocalNodeModules: true,
    node: process.version, browser: browser.version(), platform: process.platform, arch: process.arch,
    libraryVersions: Object.fromEntries(manifest.sharedLibraries.map(({ id, version }) => [id, version])),
    evidence, errors, trustedCertificateAndPhysicalDevicesTested: false }, null, 2));
} finally {
  for (const observer of observers) observer.close();
  if (browser) await browser.close();
  for (const child of children) await stop(child);
  for (const socket of proxySockets) socket.destroy();
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  udp.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
