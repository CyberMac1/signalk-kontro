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
   * True for data originating from a Venus GX / Victron device. Kontro already
   * pulls Victron data from the VRM API, so offering it here would duplicate it
   * (and burn the account's Signal K series allowance).
   * signalk-venus-plugin labels its sources `venus.com.victronenergy.*`.
   */
  function isVenusSource(source) {
    return typeof source === 'string' && /venus|victronenergy/i.test(source);
  }

  // Standard Signal K top-level groups, used to enumerate paths when the server
  // doesn't expose streambundle.getAvailablePaths().
  const SELF_ROOTS = [
    'navigation', 'environment', 'electrical', 'tanks', 'propulsion', 'steering',
    'sensors', 'performance', 'design', 'communication',
  ];

  /**
   * Sources reporting one path, via `getSelfPath(path)`.
   *
   * NOTE: use getSelfPath, NOT getPath('vessels.self.…'). getPath does
   * `_.get(signalk.retrieve(), aPath)` and the full model keys vessels by URN —
   * there is no literal `vessels.self` key, so that lookup always returns
   * undefined. getSelfPath resolves against `signalk.self` directly.
   */
  function sourcesForPath(path) {
    try {
      const node = typeof app.getSelfPath === 'function' ? app.getSelfPath(path) : null;
      if (!node || typeof node !== 'object') return [];
      const out = [];
      if (node.$source) out.push(node.$source);
      if (node.values && typeof node.values === 'object') out.push(...Object.keys(node.values));
      return out;
    } catch (_) {
      return [];
    }
  }

  /** Walk the self tree from the standard roots, collecting value-carrying leaves. */
  function pathsFromSelfTree() {
    const out = [];
    for (const root of SELF_ROOTS) {
      let node = null;
      try {
        node = typeof app.getSelfPath === 'function' ? app.getSelfPath(root) : null;
      } catch (_) { continue; }
      if (!node || typeof node !== 'object') continue;
      const walk = (n, prefix) => {
        for (const key of Object.keys(n)) {
          if (key.startsWith('$') || key === 'meta' || key === 'timestamp' || key === 'values') continue;
          const child = n[key];
          if (!child || typeof child !== 'object') continue;
          const path = `${prefix}.${key}`;
          if ('value' in child) out.push(path);
          else walk(child, path);
        }
      };
      if ('value' in node) out.push(root);
      else walk(node, root);
    }
    return out;
  }

  /**
   * Every data path the server currently sees, for the config dropdown, with
   * Venus/Victron-sourced paths removed. Returns [] when nothing can be
   * enumerated, in which case the schema falls back to free text so the user is
   * never blocked.
   */
  function availablePaths() {
    let candidates = [];
    try {
      const fromBundle = app.streambundle && typeof app.streambundle.getAvailablePaths === 'function'
        ? app.streambundle.getAvailablePaths()
        : null;
      if (Array.isArray(fromBundle)) candidates = fromBundle;
    } catch (_) { /* fall through */ }
    if (!candidates.length) candidates = pathsFromSelfTree();

    const unique = [...new Set(candidates)].filter(Boolean);

    // Drop a path only when EVERY source for it is Venus. A path also fed by a
    // non-Victron sensor stays; a path whose sources we can't read stays (fail
    // open — never silently hide data).
    const kept = [];
    const dropped = [];
    for (const p of unique) {
      const s = sourcesForPath(p);
      if (s.length > 0 && s.every(isVenusSource)) dropped.push(`${p} [${s.join(', ')}]`);
      else kept.push(p);
    }

    // Visible with the plugin's Debug switch on — the fastest way to see why a
    // path was or wasn't hidden.
    if (typeof app.debug === 'function') {
      app.debug(`paths: ${unique.length} found, ${dropped.length} hidden as Venus/Victron`);
      if (dropped.length) app.debug(`hidden: ${dropped.join(' | ')}`);
      const unknown = kept.filter((p) => sourcesForPath(p).length === 0);
      if (unknown.length) app.debug(`no source info (kept): ${unknown.slice(0, 20).join(', ')}`);
    }

    return kept.sort();
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
          // NOTE: deliberately no `uniqueItems: true`. Combined with an enum that
          // makes the form render a ctrl-click multi-select listbox, where one
          // stray click wipes the whole selection. Without it each entry is its
          // own row with a dropdown, added one at a time.
          type: 'array', title: 'Paths to send', default: [],
          items: pathItems,
          description: paths.length
            ? 'Click "Add" for each path you want to send, then choose it from the dropdown. Only paths your Signal K server is currently receiving are listed.'
            : 'No live paths detected yet — click "Add" and type them manually, e.g. environment.wind.speedApparent.',
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
    // De-duplicated: entries are added one row at a time, so the same path can
    // be picked twice — subscribing twice would double-count every sample.
    const paths = [...new Set(
      (Array.isArray(options.paths) ? options.paths : [])
        .map((p) => (typeof p === 'string' ? p.trim() : ''))
        .filter(Boolean),
    )];
    if (!paths.length) {
      app.setPluginError('Add at least one Signal K path to send.');
      return;
    }
    const periodMs = CADENCE_MS[options.cadence] || CADENCE_MS['5m'];

    const subscription = {
      context: 'vessels.self',
      // `period` implies policy 'fixed', so sending both makes the server warn
      // and ignore 'instant'. We want every sample (a true average over the
      // window), throttled by minPeriod — which is the instant-policy companion.
      subscribe: paths.map((p) => ({ path: p, policy: 'instant', minPeriod: 1000 })),
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
