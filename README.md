# homebridge-honeywell-vam
Homebridge plugin for the Honeywell Vista Automation Module.

This plugin exposes the Honeywell VAM Wi-Fi unit as a security system accessory in HomeKit through [Homebridge](http://homebridge.io).

VAM is similar to Tuxedo but never made a strong presence and has been abandoned. This is a fork of a Tuxedo plugin adapted to work with VAM v6.2.9. It relies on HTTP rather than HTTPS as VAM uses TLS 1.1, which has been obsoleted and is no longer supported by modern software. This means the Homebridge instance must be on the same local network as the VAM unit unless you set up a TLS-terminating proxy.

> **v2.0.0** — Homebridge 2.0 compatible. Requires Node.js 18+ and Homebridge 1.8+. See [Upgrading from v1.x](#upgrading-from-v1x) below.

---

## Installation

1. Install Homebridge: `npm install -g homebridge`
2. Install this plugin: `npm install https://github.com/MaverickC2/homebridge-honeywell-vam`
3. Update your configuration file. See the [Configuration](#configuration) section below or `sample-config.json` in this repository.

> **Prerequisite:** Disable **"Authentication for web server local access"** on the VAM unit under Settings → Accounts. The plugin cannot communicate with the unit without this disabled.

---

## Features

This plugin exposes two HomeKit accessories:

- **Security System** — supports Stay, Night, Away, and Disarm modes.
- **Occupancy Sensor ("Entry Delay")** — turns on when the VAM reports an active entry delay countdown, giving you automation triggers for that window.

### Mode Mapping

| HomeKit Mode | VAM Mode |
|---|---|
| Home | Stay |
| Night | Night |
| Away | Away |
| Off | Disarm |

### State Mapping

| VAM State | HomeKit State |
|---|---|
| Armed Stay | Stay |
| Armed Stay Fault | Stay |
| Armed Away | Away |
| Armed Away Fault | Away |
| Armed Night | Night |
| Armed Night Fault | Night |
| Armed Instant | Night |
| Armed Instant Fault | Night |
| Ready To Arm | Off |
| Ready Fault | Off |
| Not Ready | Off |
| Not Ready Fault | Off |
| Entry Delay Active | Occupancy Sensor (On) |
| Not Ready Alarm | Triggered |
| Armed Stay Alarm | Triggered |
| Armed Night Alarm | Triggered |
| Armed Away Alarm | Triggered |

There is no comprehensive official state list for the VAM unit; this table is compiled from observed states. If the plugin encounters an unknown state it will default to **Disarmed** to avoid a false alarm condition, and log the unknown state. If this happens please [open a GitHub issue](https://github.com/MaverickC2/homebridge-honeywell-vam/issues) so the state can be added to the mapping.

### Built-in Keepalive

The plugin pings the VAM unit on a configurable interval (default: every 60 seconds). This serves two purposes:

1. **Works around a VAM firmware bug** where the status API starts returning stale data until a browser-like HTTP request is made to the unit — no external ping tool or cron job needed.
2. **Monitors connectivity** — if the VAM unit becomes unreachable, the HomeKit accessory's Status Fault characteristic is set automatically and cleared when connectivity is restored.

---

## Configuration

### Minimum configuration

```json
"accessories": [
  {
    "accessory": "Honeywell Tuxedo Touch",
    "host": "192.168.1.100",
    "alarmCode": "1234"
  }
]
```

### All options

```json
"accessories": [
  {
    "accessory": "Honeywell Tuxedo Touch",
    "name": "Home Security",
    "host": "192.168.1.100",
    "port": "8000",
    "alarmCode": "1234",
    "polling": true,
    "pollInterval": 10000,
    "keepaliveInterval": 60000,
    "fetchKeysBeforeEverySetCall": false,
    "debug": false
  }
]
```

### Option reference

| Option | Required | Default | Description |
|---|---|---|---|
| `accessory` | ✅ | — | Must be exactly `"Honeywell Tuxedo Touch"` |
| `host` | ✅ | — | IP address or hostname of the VAM unit. Use the local LAN IP where possible. |
| `alarmCode` | ✅ | — | Your numeric alarm code for arming/disarming. |
| `name` | | `"Honeywell Security"` | Display name shown in HomeKit. |
| `port` | | _(none)_ | Port number if the VAM is not on the default HTTP port. |
| `polling` | | `false` | Enables periodic polling to keep HomeKit in sync with state changes made outside of HomeKit. Recommended. |
| `pollInterval` | | `30000` | How often to poll, in milliseconds. |
| `keepaliveInterval` | | `60000` | How often the built-in keepalive pings the VAM unit, in milliseconds. Replaces any external ping/healthcheck. |
| `fetchKeysBeforeEverySetCall` | | `false` | Forces a VAM session refresh before every arm/disarm command. Enable if commands intermittently fail. |
| `debug` | | `false` | Enables verbose debug logging in the Homebridge log. |

---

## Upgrading from v1.x

v2.0.0 is a breaking release due to Homebridge 2.0 requirements.

**Requirements:**
- Node.js **18.0.0 or later** (v1.x supported Node 10+)
- Homebridge **1.8.0 or later**

**What changed:**
- Internally migrated from callback-based HAP handlers (`.on("get"/"set")`) to Promise-based handlers (`.onGet/.onSet`) required by Homebridge 2.0.
- Removed unused dependencies (`crypto-js`, `node-html-parser`, `tough-cookie`, `util`).
- All mutable plugin state is now scoped per-accessory instance, making it safe to run multiple accessories in the same Homebridge process.
- The external keepalive/ping mechanism is now built into the plugin via `keepaliveInterval` — you can remove any cron jobs or scripts you were using for this.

**Config changes:**
- One new optional field: `keepaliveInterval` (milliseconds, default `60000`). All existing config fields are unchanged and remain compatible.

---

## Troubleshooting

**Status always shows "Not Responding" in HomeKit**
- Ensure "Authentication for web server local access" is disabled on the VAM unit (Settings → Accounts).
- Confirm the `host` value in your config is reachable from the Homebridge machine: `ping <host>`.
- Check Homebridge logs for `[_getAPIKeys]` or `[Keepalive]` error messages.

**Arm/disarm commands don't work**
- Double-check your `alarmCode` in the config.
- Try enabling `fetchKeysBeforeEverySetCall: true` as a workaround for session expiry issues.

**Unknown state logged**
- If you see `Unknown alarm state: <X>` in the logs, please [open a GitHub issue](https://github.com/MaverickC2/homebridge-honeywell-vam/issues) with the state string so it can be added to the mapping.

**Node TLS warning**
```
Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections insecure...
```
This is expected. The VAM unit ships with expired certificates that cannot be updated. The plugin disables certificate verification to communicate with it.

---

## FAQ

**Why does this use HTTP and not HTTPS?**
The VAM unit only supports TLS 1.1, which has been removed from all modern runtimes. HTTP is the only practical option unless you run a TLS 1.1-capable reverse proxy in front of the unit.

**Why is this not a platform plugin? Why doesn't it support lights/locks/etc. controlled by the VAM?**
The VAM device API has a bug where it only returns the first connected device rather than all of them. Supporting additional devices would require scraping the VAM web interface, which is a significant undertaking.

---

## Credits

Forked from [homebridge-honeywell-tuxedo-touch](https://github.com/lockpicker/homebridge-honeywell-tuxedo-touch) by lockpicker.
