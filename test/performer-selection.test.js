const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../public/shared');

test('the performer badge reuses the current connection and claim when switching numbers', async () => {
  const callbacks = new Map(), pending = [], emitted = [];
  const values = new Map([[P.storageKeys.playerId, '1'], [P.storageKeys.playerClaim, 'existing-claim']]);
  const socket = { connected: true, on() {}, emit: (...args) => emitted.push(args), io: { on() {} } };
  let selected = null;
  const window = {
    PNDS: P,
    __PNDS_CONFIG__: { role: 'performer' },
    addEventListener() {},
    scrollTo() {},
    location: { hostname: 'localhost' },
  };
  const context = vm.createContext({ window,
    location: { port: String(P.performerPort), search: '' },
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    document: { getElementById: id => ({ addEventListener: (event, callback) => callbacks.set(id + ':' + event, callback) }) },
    io: { connect: () => socket },
    createCanvas: () => ({ elt: { addEventListener() {} } }), loadImage: async () => ({}),
    frameRate() {}, windowWidth: 500, windowHeight: 700,
    setTimeout: callback => pending.push(callback), prompt: () => selected, alert() {}, Math, URLSearchParams,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/sketch.js'), 'utf8'), context);
  await vm.runInContext('setup()', context);
  const click = callbacks.get('badge-user:click');
  assert.equal(typeof click, 'function');
  click(); pending.shift()();
  assert.equal(pending.length, 0, 'cancelling a number change keeps the current selection');
  assert.equal(emitted.length, 0);
  assert.equal(values.get(P.storageKeys.playerId), '1');
  selected = '2';
  click(); pending.shift()();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], P.events.selectId);
  assert.equal(emitted[0][1].userType, '2');
  assert.equal(emitted[0][1].claimToken, 'existing-claim');
});
