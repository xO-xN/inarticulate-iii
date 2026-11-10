const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

function stylesheetRequests({ basePath, timeOrigin, random = 0.25 }) {
  const requests = [];
  const style = {};
  Object.defineProperty(style, "href", { set: value => requests.push(String(value)) });
  const context = {
    window: { PNDS_PARTICIPATION: basePath ? {
      basePath,
      resource: relative => new URL(relative, `http://host.test${basePath}`).href,
    } : undefined },
    document: { getElementById: id => { assert.equal(id, "pnds-required-style"); return style; } },
    URL,
    performance: { timeOrigin },
    Math: { random: () => random },
  };
  let foundStyle = false;
  for (const token of html.split("</head>")[0].matchAll(/<link\b[^>]*>|<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (token[0].startsWith("<link")) {
      if (!token[0].includes('id="pnds-required-style"')) continue;
      foundStyle = true;
      const initial = token[0].match(/\bhref="([^"]+)"/);
      if (initial) style.href = initial[1];
    } else if (foundStyle) {
      if (/\bsrc=/.test(token[1])) break;
      vm.runInNewContext(token[2], context);
    }
  }
  assert.ok(foundStyle, "the actual page owns a required stylesheet");
  return requests;
}

test("new confirmed Documents request distinct stylesheets under the same confirmed resource prefix", () => {
  const first = stylesheetRequests({ basePath: "/__pnds/run/confirmed/", timeOrigin: 100 });
  const retry = stylesheetRequests({ basePath: "/__pnds/run/confirmed/", timeOrigin: 101 });
  assert.equal(first.length, 1, "the initial href must already distinguish the Document");
  assert.equal(retry.length, 1);
  assert.notEqual(first[0], retry[0]);
  const reducedPrecision = stylesheetRequests({ basePath: "/__pnds/run/confirmed/", timeOrigin: 100, random: 0.5 });
  assert.notEqual(first[0], reducedPrecision[0], "Documents remain distinct when timeOrigin precision is reduced");
  for (const href of [first[0], retry[0], reducedPrecision[0]]) {
    const url = new URL(href);
    assert.equal(url.origin, "http://host.test");
    assert.equal(url.pathname, "/__pnds/run/confirmed/style.css");
    assert.deepEqual([...url.searchParams.keys()], ["pndsDocument"]);
    assert.ok(url.searchParams.get("pndsDocument"));
  }
});

test("native and standalone Documents keep the original stylesheet href", () => {
  assert.deepEqual(stylesheetRequests({ basePath: "/", timeOrigin: 100 }), ["style.css"]);
  assert.deepEqual(stylesheetRequests({ timeOrigin: 101 }), ["style.css"]);
});
