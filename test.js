/**
 * Minimal dependency-free smoke test — run with `npm test` (node test.js).
 * Exercises the buffer → aggregate → POST payload path with a mock Signal K
 * `app` and a mock global fetch. Exits non-zero on failure.
 */
'use strict';
const assert = require('assert');
const makePlugin = require('./index.js');

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL-', name, '\n       ', e.message); }
}

// Mock Signal K app.
function mockApp() {
  return {
    status: null, error: null,
    setPluginStatus(m) { this.status = m; },
    setPluginError(m) { this.error = m; },
    getMetadata(path) {
      if (path.endsWith('angleApparent')) return { units: 'rad' };
      if (path.endsWith('speedApparent')) return { units: 'm/s' };
      return null;
    },
    subscriptionmanager: {
      subscribe(_sub, unsubscribes, _err, _delta) { unsubscribes.push(() => {}); },
    },
    streambundle: {
      getAvailablePaths() {
        return ['environment.wind.speedApparent', 'electrical.batteries.0.voltage', 'navigation.speedOverGround'];
      },
    },
  };
}

/** A server that can't enumerate paths (no streambundle). */
function bareApp() {
  const a = mockApp();
  delete a.streambundle;
  return a;
}

/**
 * Mimics the server's getSelfPath: lodash-style get against the self vessel.
 * (getPath('vessels.self.…') does NOT work — the full model keys vessels by URN.)
 */
function selfPathGetter(tree) {
  return (p) => String(p).split('.').reduce(
    (n, k) => (n && typeof n === 'object' ? n[k] : undefined), tree,
  );
}

async function run() {
// 1) schema: required token + paths, cadence enum, server checkbox, no removed fields
await check('schema shape', () => {
  const p = makePlugin(mockApp());
  const s = p.schema();
  assert.deepStrictEqual(s.required, ['ingestToken', 'paths']);
  assert.deepStrictEqual(s.properties.cadence.enum, ['1m', '5m', '10m', '15m']);
  assert.strictEqual(s.properties.useDefaultServer.default, true);
  assert.ok(!('sendAllNumeric' in s.properties), 'sendAllNumeric removed');
  assert.ok(!('statistics' in s.properties), 'statistics removed');
  assert.ok(!('endpoint' in s.properties), 'endpoint field removed');
  assert.strictEqual(p.id, 'signalk-kontro');
});

// 1b) the custom server URL field is ALWAYS present (a conditional `dependencies`
// block didn't render in the Signal K admin UI, so the field is plain and the
// checkbox just decides whether it is used).
await check('custom server URL field always present', () => {
  const s = makePlugin(mockApp()).schema();
  assert.ok(s.properties.customEndpoint, 'customEndpoint present');
  assert.strictEqual(s.properties.customEndpoint.type, 'string');
  assert.ok(!s.dependencies, 'no conditional dependencies block');
  const p = makePlugin(mockApp());
  assert.ok(p.uiSchema['ui:order'].includes('customEndpoint'), 'ordered after the checkbox');
});

// 1c) paths render as a dropdown of what the server actually sees
await check('paths is a dropdown of available paths', () => {
  const s = makePlugin(mockApp()).schema();
  assert.strictEqual(s.properties.paths.type, 'array');
  assert.deepStrictEqual(s.properties.paths.items.enum, [
    'electrical.batteries.0.voltage',
    'environment.wind.speedApparent',
    'navigation.speedOverGround',
  ], 'sorted enum of live paths');
  // uniqueItems + enum makes the form render a ctrl-click multi-select listbox
  // (one stray click clears everything) — we want add-a-row-then-pick instead.
  assert.ok(!s.properties.paths.uniqueItems, 'no uniqueItems → per-row dropdowns');
});

// 1f) duplicate path entries are only subscribed once
await check('duplicate paths are de-duplicated on start', () => {
  const app = mockApp();
  const subscribed = [];
  app.subscriptionmanager.subscribe = (sub, un) => {
    subscribed.push(...sub.subscribe.map((x) => x.path));
    un.push(() => {});
  };
  const p = makePlugin(app);
  p.start({ ingestToken: 'k', cadence: '15m', paths: ['a.b', 'a.b', ' a.b ', 'c.d', ''] });
  assert.deepStrictEqual(subscribed, ['a.b', 'c.d']);
  p.stop();
});

// 1f2) a second start() must not leave two intervals running (double send rate)
await check('start() twice does not double the send rate', () => {
  const app = mockApp();
  let live = 0;
  const realSet = global.setInterval, realClear = global.clearInterval;
  global.setInterval = (...a) => { live++; return realSet(...a); };
  global.clearInterval = (h) => { if (h) live--; return realClear(h); };
  const p = makePlugin(app);
  p.start({ ingestToken: 'k', cadence: '1m', paths: ['a.b'] });
  p.start({ ingestToken: 'k', cadence: '1m', paths: ['a.b'] });   // no stop() between
  assert.strictEqual(live, 1, 'exactly one interval should be running');
  p.stop();
  assert.strictEqual(live, 0, 'stop() clears it');
  global.setInterval = realSet; global.clearInterval = realClear;
});

// 1g) subscription spec must not mix `period` with policy 'instant' — the server
// warns "period assumes policy 'fixed', ignoring policy instant" and drops it.
await check('subscribes with instant policy + minPeriod, never period', () => {
  const app = mockApp();
  let spec = null;
  app.subscriptionmanager.subscribe = (sub, un) => { spec = sub; un.push(() => {}); };
  const p = makePlugin(app);
  p.start({ ingestToken: 'k', cadence: '5m', paths: ['a.b'] });
  assert.strictEqual(spec.context, 'vessels.self');
  assert.strictEqual(spec.subscribe[0].policy, 'instant');
  assert.strictEqual(spec.subscribe[0].minPeriod, 1000);
  assert.ok(!('period' in spec.subscribe[0]), 'no period alongside instant');
  p.stop();
});

// 1h) Venus/Victron paths are hidden — that data already reaches Kontro via VRM
await check('Venus-sourced paths are excluded from the list', () => {
  const app = bareApp();
  app.getSelfPath = selfPathGetter({
    electrical: { batteries: { 0: {
      // Victron battery via signalk-venus-plugin → excluded
      voltage: { value: 12.8, $source: 'venus.com.victronenergy.battery.ttyO2' },
    } } },
    environment: { wind: {
      // genuine NMEA sensor → kept
      speedApparent: { value: 5, $source: 'n2k-1.115' },
    } },
    navigation: {
      // reported by BOTH Venus and a real sensor → kept (not exclusively Venus)
      speedOverGround: { value: 3, $source: 'venus.com.victronenergy.gps', values: { 'n2k-1.22': {} } },
    },
    tanks: { freshWater: { 0: {
      currentLevel: { value: 0.5, $source: 'venus.com.victronenergy.tank.ttyUSB0' },
    } } },
  });
  const s = makePlugin(app).schema();
  assert.deepStrictEqual(s.properties.paths.items.enum, [
    'environment.wind.speedApparent',
    'navigation.speedOverGround',
  ]);
});

// 1i) Venus filtering also applies to the getAvailablePaths() list
await check('Venus filtering applies to streambundle paths too', () => {
  const app = mockApp();
  app.streambundle.getAvailablePaths = () => [
    'electrical.batteries.0.voltage',
    'environment.wind.speedApparent',
  ];
  app.getSelfPath = selfPathGetter({
    electrical: { batteries: { 0: { voltage: { value: 12.8, $source: 'venus.com.victronenergy.battery' } } } },
    environment: { wind: { speedApparent: { value: 5, $source: 'n2k-1.115' } } },
  });
  const s = makePlugin(app).schema();
  assert.deepStrictEqual(s.properties.paths.items.enum, ['environment.wind.speedApparent']);
});

// 1j) regression guard: getPath('vessels.self') always returns undefined on a real
// server (the full model keys vessels by URN), so it must never be relied on.
await check('does not depend on getPath("vessels.self")', () => {
  const app = bareApp();
  let usedGetPath = false;
  app.getPath = () => { usedGetPath = true; return undefined; };
  app.getSelfPath = selfPathGetter({
    environment: { wind: { speedApparent: { value: 5, $source: 'n2k-1.115' } } },
  });
  const s = makePlugin(app).schema();
  assert.deepStrictEqual(s.properties.paths.items.enum, ['environment.wind.speedApparent']);
  assert.strictEqual(usedGetPath, false, 'getPath must not be used for discovery');
});

// 1d) …falling back to free text when the server can't enumerate paths
await check('paths falls back to free text', () => {
  const s = makePlugin(bareApp()).schema();
  assert.strictEqual(s.properties.paths.items.type, 'string');
  assert.ok(!s.properties.paths.items.enum, 'no enum when nothing is known');
  assert.match(s.properties.paths.description, /type them manually/);
});

// 1e) no streambundle → derive paths by walking the vessels.self tree
await check('paths fall back to the vessels.self tree', () => {
  const app = bareApp();
  app.getSelfPath = selfPathGetter({
    environment: { wind: { speedApparent: { value: 5, timestamp: 'x' } } },
    electrical: { batteries: { 0: { voltage: { value: 12.8 } } } },
    name: 'Boaty',                        // not a standard root → skipped
    $source: { ignored: { value: 1 } },   // not a standard root → skipped
  });
  const s = makePlugin(app).schema();
  assert.deepStrictEqual(s.properties.paths.items.enum, [
    'electrical.batteries.0.voltage',
    'environment.wind.speedApparent',
  ]);
});

// 2) always sends all four aggregates (avg/min/max/last)
await check('aggregate is all four', () => {
  const p = makePlugin(mockApp());
  const { record, aggregate, buffers } = p._internals;
  record('environment.wind.speedApparent', 'n2k-1.115', 4);
  record('environment.wind.speedApparent', 'n2k-1.115', 6);
  const b = buffers.get(p._internals.seriesKey('environment.wind.speedApparent', 'n2k-1.115'));
  const r = aggregate(b);
  assert.strictEqual(r.avg, 5);
  assert.strictEqual(r.min, 4);
  assert.strictEqual(r.max, 6);
  assert.strictEqual(r.last, 6);
  assert.strictEqual(r.unit, 'm/s');
  assert.strictEqual(r.src, 'n2k-1.115');
});

// 3) angular paths use circular mean (350° and 10° average to 0°, not 180°)
await check('circular mean for radians', () => {
  const p = makePlugin(mockApp());
  const { record, aggregate, buffers } = p._internals;
  const d2r = (d) => (d * Math.PI) / 180;
  record('environment.wind.angleApparent', '', d2r(350));
  record('environment.wind.angleApparent', '', d2r(10));
  const b = buffers.get(p._internals.seriesKey('environment.wind.angleApparent', ''));
  const r = aggregate(b);
  const deg = (r.avg * 180) / Math.PI;
  // ~0° (or ~360°) — definitely not the 180° an arithmetic mean would give.
  assert.ok(deg < 1 || deg > 359, `expected ~0°, got ${deg.toFixed(2)}°`);
});

// 3b) endpoint resolution: default server vs custom
await check('resolveEndpoint', () => {
  const { resolveEndpoint } = makePlugin(mockApp())._internals;
  assert.strictEqual(resolveEndpoint({}), 'https://app.kontro.ai/api/ingest');
  assert.strictEqual(resolveEndpoint({ useDefaultServer: true, customEndpoint: 'https://x' }), 'https://app.kontro.ai/api/ingest');
  assert.strictEqual(resolveEndpoint({ useDefaultServer: false, customEndpoint: 'https://x/api/ingest' }), 'https://x/api/ingest');
  // off but blank custom → still the default (safe fallback)
  assert.strictEqual(resolveEndpoint({ useDefaultServer: false }), 'https://app.kontro.ai/api/ingest');
});

// 4) non-numeric values are ignored (position object, string)
await check('non-numeric ignored', () => {
  const p = makePlugin(mockApp());
  const { record, buffers } = p._internals;
  record('navigation.position', '', { latitude: 1, longitude: 2 });
  record('navigation.state', '', 'sailing');
  assert.strictEqual(buffers.size, 0);
});

// 5) flush() POSTs the right payload and resets the window
await check('flush posts payload + resets', async () => {
  const app = mockApp();
  const p = makePlugin(app);
  const { record, flush } = p._internals; // read buffers via the live getter, not a stale ref
  record('electrical.batteries.0.voltage', '', 12.8);
  record('electrical.batteries.0.voltage', '', 13.0);

  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ accepted: captured.body.readings.length }) };
  };

  await flush({ useDefaultServer: false, customEndpoint: 'https://example.test/api/ingest', ingestToken: 'kni_test' });

  assert.strictEqual(captured.url, 'https://example.test/api/ingest');
  assert.strictEqual(captured.opts.headers.Authorization, 'Bearer kni_test');
  assert.strictEqual(captured.body.readings.length, 1);
  const reading = captured.body.readings[0];
  assert.strictEqual(reading.path, 'electrical.batteries.0.voltage');
  assert.strictEqual(reading.avg, 12.9);
  assert.strictEqual(reading.last, 13.0);
  assert.ok(Number.isInteger(reading.ts), 'ts is unix seconds');
  assert.strictEqual(p._internals.buffers.size, 0, 'window reset after flush');
  assert.match(app.status, /Sent 1 series/);
});

// 6) flush surfaces a non-2xx as a plugin error
await check('flush reports rejection', async () => {
  const app = mockApp();
  const p = makePlugin(app);
  const { record, flush } = p._internals;
  record('x', '', 1);
  global.fetch = async () => ({ ok: false, status: 422, text: async () => 'cadence_not_allowed' });
  await flush({ useDefaultServer: false, customEndpoint: 'https://example.test', ingestToken: 'k' });
  assert.match(app.error, /422/);
});

// 7) never POST a window that has nothing in it
await check('no POST when Signal K supplied nothing', async () => {
  const app = mockApp();
  const p = makePlugin(app);
  const { flush } = p._internals;
  let posted = 0;
  global.fetch = async () => { posted++; return { ok: true, json: async () => ({}) }; };
  await flush({ useDefaultServer: true, ingestToken: 'k' });
  assert.strictEqual(posted, 0, 'empty window must not be sent');
  assert.match(app.status, /Waiting for data/);
});

// 8) values that mean "no reading" never become a series
await check('null / non-numeric values are not recorded', async () => {
  const app = mockApp();
  const p = makePlugin(app);
  const { record, flush } = p._internals;
  let posted = 0;
  global.fetch = async () => { posted++; return { ok: true, json: async () => ({}) }; };
  // A sensor dropping out sends null; position sends an object; some send strings.
  record('environment.wind.speedApparent', 'n2k-1', null);
  record('environment.depth.belowTransducer', 'n2k-1', undefined);
  record('navigation.position', 'n2k-1', { latitude: 1, longitude: 2 });
  record('a.string', 'n2k-1', 'N/A');
  record('a.nan', 'n2k-1', NaN);
  record('a.bool', 'n2k-1', true);
  assert.strictEqual(p._internals.buffers.size, 0, 'no buffers created');
  await flush({ useDefaultServer: true, ingestToken: 'k' });
  assert.strictEqual(posted, 0, 'nothing to send');
});

// 9) a dead sensor keeps the timestamp of its LAST sample, not the flush time
await check('ts reflects the last sample, not the flush', async () => {
  const app = mockApp();
  const p = makePlugin(app);
  const { record, aggregate } = p._internals;
  record('x', '', 1);
  const b = p._internals.buffers.get('x ');
  b.lastAt = Date.now() - 10 * 60_000;      // arrived 10 minutes ago
  const r = aggregate(b);
  const ageSec = Math.floor(Date.now() / 1000) - r.ts;
  assert.ok(ageSec >= 595, `ts should be ~10 min old, was ${ageSec}s`);
});

// 10) a partly-empty window sends only the series that reported
await check('mixed window sends only live series', async () => {
  const app = mockApp();
  const p = makePlugin(app);
  const { record, flush } = p._internals;
  let body = null;
  global.fetch = async (_u, o) => { body = JSON.parse(o.body); return { ok: true, json: async () => ({}) }; };
  record('live.path', 'n2k-1', 5.2);
  record('dead.path', 'n2k-1', null);
  await flush({ useDefaultServer: true, ingestToken: 'k' });
  assert.strictEqual(body.readings.length, 1);
  assert.strictEqual(body.readings[0].path, 'live.path');
});

}

run().then(() => {
  console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll tests passed');
  process.exit(failures ? 1 : 0);
});
