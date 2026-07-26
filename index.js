/**
 * signalk-kontro — Signal K server plugin.
 *
 * Streams the self-vessel Signal K paths you select, averages each series over a
 * chosen cadence window, and POSTs all four aggregates to Kontro's ingest API.
 * Generic: you pick the paths in the plugin config; no code change per data type.
 *
 * Payload contract (must match Kontro server/ingest.js):
 *   POST {endpoint}  Authorization: Bearer {connection key}
 *   { "readings": [ { path, src, unit, ts(seconds), avg, min, max, last }, ... ] }
 *
 * See the Kontro spec: docs/signalk-integration-spec.md in the Kontro repo.
 */
'use strict';

const DEFAULT_ENDPOINT = 'https://app.kontro.ai/api/ingest';
const CADENCE_MS = { '1m': 60000, '5m': 300000, '10m': 600000, '15m': 900000 };

module.exports = function (app) {
  const plugin = {};
  plugin.id = 'signalk-kontro';
  plugin.name = 'Kontro';
  plugin.description = 'Send selected Signal K data to your Kontro dashboard (averaged, low-cadence).';

  let unsubscribes = [];
  let timer = null;
  let buffers = new Map();          // seriesKey -> { path, src, unit, angular, samples[], last }
  const metaCache = new Map();      // path -> { units, angular }

  /**
   * Every data path the server currently sees, for the config dropdown.
   * `getAvailablePaths()` is the documented API; the vessels.self tree is a
   * fallback for servers that don't expose it. Returns [] if neither works, in
   * which case the schema falls back to free text so the user is never blocked.
   */
  function availablePaths() {
    try {
      const fromBundle = app.streambundle && typeof app.streambundle.getAvailablePaths === 'function'
        ? app.streambundle.getAvailablePaths()
        : null;
      if (Array.isArray(fromBundle) && fromBundle.length) return [...new Set(fromBundle)].sort();
    } catch (_) { /* fall through */ }

    // Fallback: walk vessels.self and collect every leaf that carries a value.
    try {
      const self = typeof app.getPath === 'function' ? app.getPath('vessels.self') : null;
      if (self && typeof self === 'object') {
        const out = [];
        const walk = (node, prefix) => {
          for (const key of Object.keys(node)) {
            if (key.startsWith('$') || key === 'meta' || key === 'timestamp') continue;
            const child = node[key];
            if (!child || typeof child !== 'object') continue;
            const path = prefix ? `${prefix}.${key}` : key;
            if ('value' in child) out.push(path);
            else walk(child, path);
          }
        };
        walk(self, '');
        if (out.length) return [...new Set(out)].sort();
      }
    } catch (_) { /* give up — free-text fallback below */ }
    return [];
  }

  // ── Config schema (Signal K renders the form from this) ────────────────────
  // Property order = form order. The server setting is intentionally LAST so
  // users never touch it under normal use.
  plugin.schema = () => {
    const paths = availablePaths();
    // A dropdown when we know what's available; free text when we don't (so a
    // server that can't enumerate paths is still configurable).
    const pathItems = paths.length
      ? { type: 'string', enum: paths }
      : { type: 'string' };

    return {
      type: 'object',
      required: ['ingestToken', 'paths'],
      properties: {
        ingestToken: {
          type: 'string', title: 'Connection key',
          description: 'Generate this in Kontro → Settings → Integrations → Signal K, then paste it here.',
        },
        cadence: {
          type: 'string', title: 'Update cadence', default: '5m',
          enum: ['1m', '5m', '10m', '15m'],
          enumNames: ['1 minute', '5 minutes', '10 minutes', '15 minutes'],
          description: '1 minute requires a Kontro Plus plan; Starter accounts must use 5 minutes or slower.',
        },
        paths: {
          type: 'array', title: 'Paths to send', default: [],
          items: pathItems,
          uniqueItems: true,
          description: paths.length
            ? 'Pick each path to send. Only paths your Signal K server is currently receiving are listed.'
            : 'No live paths detected yet — type them manually, e.g. environment.wind.speedApparent.',
        },
        useDefaultServer: {
          type: 'boolean', title: 'Use default Kontro server', default: true,
          description: 'Leave this on. Only turn it off if Kontro support asked you to use a custom server.',
        },
        customEndpoint: {
          type: 'string', title: 'Custom Kontro server URL',
          description: 'Only used when "Use default Kontro server" is unticked. Do not change unless Kontro support gave you a URL.',
        },
      },
    };
  };

  plugin.uiSchema = {
    'ui:order': ['ingestToken', 'cadence', 'paths', 'useDefaultServer', 'customEndpoint', '*'],
    ingestToken: { 'ui:widget': 'password' },
    customEndpoint: { 'ui:placeholder': DEFAULT_ENDPOINT },
  };

  function resolveEndpoint(options) {
    if (options.useDefaultServer === false && options.customEndpoint) return options.customEndpoint;
    return DEFAULT_ENDPOINT;
  }

  // ── Metadata (units + angular detection) — best-effort, cached ─────────────
  function metaFor(path) {
    if (metaCache.has(path)) return metaCache.get(path);
    let units = null;
    try {
      const m =
        (app.getMetadata && (app.getMetadata(path) || app.getMetadata('vessels.self.' + path))) || null;
      units = (m && m.units) || null;
    } catch (_) { /* meta unavailable — treat as linear */ }
    const info = { units, angular: units === 'rad' };
    metaCache.set(path, info);
    return info;
  }

  function seriesKey(path, src) { return path + ' ' + (src || ''); }

  function record(path, src, value) {
    if (typeof value !== 'number' || !isFinite(value)) return; // numeric scalars only (v1)
    const key = seriesKey(path, src);
    let b = buffers.get(key);
    if (!b) {
      const meta = metaFor(path);
      b = { path, src: src || '', unit: meta.units, angular: meta.angular, samples: [], last: null };
      buffers.set(key, b);
    }
    b.samples.push(value);
    b.last = value;
  }

  // ── Aggregation — always all four (avg / min / max / last) ─────────────────
  function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
  function circularMean(a) {
    let s = 0, c = 0;
    for (const v of a) { s += Math.sin(v); c += Math.cos(v); }
    let m = Math.atan2(s / a.length, c / a.length);
    if (m < 0) m += 2 * Math.PI; // normalise to [0, 2π)
    return m;
  }

  function aggregate(b) {
    if (!b.samples.length) return null;
    return {
      path: b.path, src: b.src, unit: b.unit || undefined,
      ts: Math.floor(Date.now() / 1000),
      avg: b.angular ? circularMean(b.samples) : mean(b.samples),
      min: Math.min(...b.samples),
      max: Math.max(...b.samples),
      last: b.last,
    };
  }

  // ── Flush: build the batch and POST it ─────────────────────────────────────
  async function flush(options) {
    const readings = [];
    for (const b of buffers.values()) {
      const r = aggregate(b);
      if (r) readings.push(r);
    }
    buffers = new Map(); // reset the window
    if (!readings.length) { app.setPluginStatus('Waiting for data…'); return; }

    try {
      const resp = await fetch(resolveEndpoint(options), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.ingestToken}` },
        body: JSON.stringify({ readings }),
      });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 160);
        app.setPluginError(`Kontro rejected the update (${resp.status}) ${detail}`);
        return;
      }
      const body = await resp.json().catch(() => ({}));
      app.setPluginStatus(`Sent ${body.accepted ?? readings.length} series at ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      app.setPluginError('Could not reach Kontro: ' + String(e && e.message ? e.message : e).slice(0, 160));
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  plugin.start = function (options) {
    options = options || {};
    if (!options.ingestToken) {
      app.setPluginError('Set your Kontro connection key in the plugin configuration.');
      return;
    }
    const paths = (Array.isArray(options.paths) ? options.paths : [])
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean);
    if (!paths.length) {
      app.setPluginError('Add at least one Signal K path to send.');
      return;
    }
    const periodMs = CADENCE_MS[options.cadence] || CADENCE_MS['5m'];

    const subscription = {
      context: 'vessels.self',
      subscribe: paths.map((p) => ({ path: p, period: 1000, policy: 'instant' })),
    };

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (err) => app.setPluginError('Subscription error: ' + err),
      (delta) => {
        if (!delta || !delta.updates) return;
        for (const u of delta.updates) {
          if (!u.values) continue;
          const src = u.$source || (u.source && u.source.label) || '';
          for (const v of u.values) record(v.path, src, v.value);
        }
      },
    );

    timer = setInterval(() => { flush(options); }, periodMs);
    app.setPluginStatus(`Started — sending ${paths.length} path(s) every ${options.cadence || '5m'}`);
  };

  plugin.stop = function () {
    if (timer) { clearInterval(timer); timer = null; }
    unsubscribes.forEach((f) => { try { f(); } catch (_) { /* ignore */ } });
    unsubscribes = [];
    buffers = new Map();
    app.setPluginStatus && app.setPluginStatus('Stopped');
  };

  // Exposed for unit testing (see test.js).
  plugin._internals = { record, aggregate, flush, mean, circularMean, resolveEndpoint, get buffers() { return buffers; }, seriesKey };

  return plugin;
};
