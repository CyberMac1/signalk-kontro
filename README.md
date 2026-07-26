# signalk-kontro

Send selected [Signal K](https://signalk.org) data — anything on your NMEA 2000 / NMEA 0183
network that Signal K sees — to your [Kontro](https://kontro.ai) dashboard. Values are
**averaged over a cadence you choose** (1 / 5 / 10 / 15 minutes) and pushed to Kontro over
HTTPS, where they power live widgets and up to 30 days of history.

The plugin is **generic**: you pick which paths to send in the config. New data types never
require a plugin update.

## Install

From your Signal K server admin → **Appstore**, search for **Kontro** and install, then
restart when prompted.

Or from the command line, in your Signal K config directory (usually `~/.signalk`):

```bash
npm install signalk-kontro
```

Restart the Signal K server after installing.

## Configure

Open **Server → Plugin Config → Kontro** and set:

| Field | What it does |
|-------|--------------|
| **Connection key** | Generate it in Kontro → **Settings → Integrations → Signal K**, then paste it here. It ties this data to one of your systems. |
| **Update cadence** | How often to send. Values are averaged across the window. `1 minute` needs a Kontro **Plus** plan; **Starter** must use 5 minutes or slower. |
| **Paths to send** | Click **Add** for each path you want to send, then pick it from the dropdown — the list shows what your Signal K server is currently receiving. At least one is required. (If the server can't list them, type them in, e.g. `environment.wind.speedApparent`.) |
| **Use default Kontro server** | Leave this on. Turn it off only if Kontro support asked you to use a custom server, then put their URL in **Custom Kontro server URL**. |

Save and enable the plugin. The status line shows when data was last sent.

## Good to know

- All four aggregates — **average, minimum, maximum and last** — are sent for every path,
  every window.
- **Numeric values only.** Position, attitude and text paths are skipped.
- **Angles are averaged correctly.** Paths measured in radians (wind angle, heading, …) use a
  circular mean, so 350° and 10° average to ~0°, not 180°.
- **Two sensors on the same path stay separate**, so you can chart each one individually.
- **Victron data is left out on purpose.** Paths coming from a Venus GX (via
  signalk-venus-plugin) aren't offered in the list, because Kontro already gets that
  data straight from the VRM API. If a path is reported by both a Venus device *and*
  another sensor, it still appears.
- Your Kontro plan sets how many paths you can store per system, and how long history is kept.

## Develop

```bash
npm test
```

Runs a dependency-free smoke test of the aggregation and send logic.

## License

MIT
