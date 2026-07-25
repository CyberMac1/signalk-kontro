# signalk-kontro

Send selected [Signal K](https://signalk.org) data — anything on your NMEA 2000 / NMEA 0183
network that Signal K sees — to your [Kontro](https://kontro.ai) dashboard. Values are
**averaged over a cadence you choose** (1 / 5 / 10 / 15 minutes) and pushed to Kontro over
HTTPS, where they power live widgets and up to 30 days of history.

The plugin is **generic**: you pick which paths to send in the config. New data types never
require a plugin update.

## Install

From your Signal K server admin → **Appstore**, search for **Kontro** and install, then
restart when prompted. (Or `npm install signalk-kontro` in your server's plugin directory.)

## Configure

Open **Server → Plugin Config → Kontro** and set:

| Field | What it does |
|-------|--------------|
| **Connection key** | Generate it in Kontro → **Settings → Integrations → Signal K**, then paste it here. It ties this data to one of your systems. |
| **Update cadence** | How often to send. Values are averaged across the window. `1 minute` needs a Kontro **Plus** plan; **Starter** must use 5 minutes or slower. |
| **Send all numeric paths** | On = send every numeric self-vessel path. Off = only the paths you list below. |
| **Paths to send** | e.g. `environment.wind.speedApparent`, `electrical.batteries.0.voltage`. Ignored when "send all" is on. |
| **Aggregates to send** | Which of `avg` / `min` / `max` / `last` to include per window. |

Save and enable the plugin. The plugin status line shows when data was last sent.

## What gets sent

Per cadence window, for each `path` + sensor `$source` seen, one reading:

```json
{
  "readings": [
    { "path": "environment.wind.speedApparent", "src": "n2k-1.115",
      "unit": "m/s", "ts": 1690000000, "avg": 5.1, "min": 4.2, "max": 6.0, "last": 5.4 }
  ]
}
```

Sent to your Kontro ingest endpoint with `Authorization: Bearer <connection key>`.

Notes:
- **Numeric scalar paths only** (v1). Position, attitude objects, and text paths are skipped.
- **Angular paths** (units `rad`, e.g. wind angle, heading) are averaged with a **circular
  mean**, so 350° and 10° average to ~0°, not 180°.
- Multiple sensors reporting the same path are kept **separate** (by `$source`).
- Your Kontro plan caps how many distinct series you can store per system.

## Develop

```bash
npm test
```

Runs a dependency-free smoke test of the aggregation + POST payload.

## License

MIT
