"use strict";
var got = require("got");
var pollingtoevent = require("polling-to-event");

let Service, Characteristic;

var protocol = "http";
var apibasepath = "/system_http_api/API_REV01";

var alarmStatus = {
  "Armed Stay"         : 0,
  "Armed Stay Fault"   : 0,
  "Armed Away"         : 1,
  "Armed Away Fault"   : 1,
  "Armed Night"        : 2,
  "Armed Instant"      : 2,
  "Armed Instant Fault": 2,
  "Armed Night Fault"  : 2,
  "Ready Fault"        : 3,
  "Ready To Arm"       : 3,
  "Not Ready"          : 3,
  "Not Ready Fault"    : 3,
  // "Entry Delay Active" intentionally not mapped here, handled in logic
  "Not Ready Alarm"    : 4,
  "Armed Stay Alarm"   : 4,
  "Armed Night Alarm"  : 4,
  "Armed Away Alarm"   : 4,
  "Not available"      : 5,
  "Error"              : 5,
};

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory(
    "homebridge-honeywell-vam",
    "Honeywell Tuxedo Touch",
    HoneywellTuxedoAccessory
  );
};

function HoneywellTuxedoAccessory(log, config) {
  this.log = log;
  this.config = config;
  this.debug = config.debug || false;
  this.fetchKeysBeforeEverySetCall = config.fetchKeysBeforeEverySetCall || false;
  this.polling = config.polling || false;
  this.pollInterval = config.pollInterval || 30000;
  this.keepaliveInterval = config.keepaliveInterval || 60000;

  // All mutable state lives on the instance — safe for multiple accessories
  this.currentState = 3;
  this.targetState = 3;
  this.lastTargetState = 3;
  this.lastValidCurrentState = 3;
  this._keepaliveTimer = null;
  this._keepaliveFaulted = false;

  this.name = config.name || "Honeywell Security";
  this.host = config.host;
  this.port = config.port || "";
  this.protocol = config.protocol || "http";

  if (!config.alarmCode) {
    this.log("Alarm code is missing from config");
  }
  this.uCode = config.alarmCode;

  // create a new Security System service
  this.SecuritySystem = new Service.SecuritySystem(this.name);

  // Homebridge 2.0: use onGet/onSet (Promise-based) instead of deprecated .on("get"/"set")
  this.SecuritySystem
    .getCharacteristic(Characteristic.SecuritySystemCurrentState)
    .onGet(this.handleSecuritySystemCurrentStateGet.bind(this));

  this.SecuritySystem
    .getCharacteristic(Characteristic.SecuritySystemTargetState)
    .onGet(this.handleSecuritySystemTargetStateGet.bind(this))
    .onSet(this.handleSecuritySystemTargetStateSet.bind(this));

  // Occupancy Sensor for Entry Delay Active state
  this.EntryDelaySensor = new Service.OccupancySensor("Entry Delay");
  this.EntryDelaySensor.displayName = "Entry Delay";
  this.EntryDelaySensor
    .getCharacteristic(Characteristic.OccupancyDetected)
    .onGet(this.handleEntryDelayGet.bind(this));

  if (this.debug) this.log("Service creation complete");

  // Kick off async init after construction
  (async () => {
    await this._getAPIKeys();
    this.init();
  })();
}

HoneywellTuxedoAccessory.prototype = {

  /**
   * Init: start polling and keepalive after API keys have been retrieved.
   */
  init: function () {
    if (this.debug) this.log("[init] Polling is set to: " + this.polling);

    if (this.polling) {
      this.log("Starting polling with an interval of %s ms", this.pollInterval);

      var self = this;

      var emitterConfig = [
        {
          method: self.handleSecuritySystemCurrentStateGet.bind(self),
          property: "current state",
          characteristic: Characteristic.SecuritySystemCurrentState,
        },
        {
          method: self.handleSecuritySystemTargetStateGet.bind(self),
          property: "target state",
          characteristic: Characteristic.SecuritySystemTargetState,
        },
      ];

      emitterConfig.forEach((cfg) => {
        var emitter = pollingtoevent(
          function (done) {
            // onGet handlers now return Promises; bridge them to the done callback
            cfg.method()
              .then((result) => done(null, result))
              .catch((err) => done(err));
          },
          { longpolling: true, interval: self.pollInterval }
        );

        emitter.on("longpoll", function (state) {
          if (state != 5) {
            self.log(
              "Polling noticed %s change to %s, notifying devices",
              cfg.property,
              state
            );
            if (cfg.property === "target state") {
              if (state == 4) {
                // HomeKit does not accept 4 (triggered) for target state
                if (self.debug)
                  self.log(
                    "Received target state 4, setting target state to lastTargetState: " +
                      self.lastTargetState
                  );
                self.SecuritySystem
                  .getCharacteristic(cfg.characteristic)
                  .updateValue(self.lastTargetState);
              } else {
                self.lastTargetState = state;
                self.SecuritySystem
                  .getCharacteristic(cfg.characteristic)
                  .updateValue(state);
              }
            } else {
              self.SecuritySystem
                .getCharacteristic(cfg.characteristic)
                .updateValue(state);
            }
            // Clear any status fault
            self.SecuritySystem
              .getCharacteristic(Characteristic.StatusFault)
              .updateValue(0);
          } else {
            // State 5 = error / not available
            self.SecuritySystem
              .getCharacteristic(Characteristic.StatusFault)
              .updateValue(1);
            self.log("Security system state unavailable, setting state to fault");
          }
        });

        emitter.on("error", function (err) {
          self.log("Polling of %s failed, error was %s", cfg.property, err);
          self.SecuritySystem
            .getCharacteristic(Characteristic.StatusFault)
            .updateValue(1);
        });
      });

      // Polling for Entry Delay occupancy sensor
      var entryDelayEmitter = pollingtoevent(
        function (done) {
          self.handleEntryDelayGet()
            .then((result) => done(null, result))
            .catch((err) => done(err));
        },
        { longpolling: true, interval: self.pollInterval }
      );
      entryDelayEmitter.on("longpoll", function (state) {
        self.EntryDelaySensor
          .getCharacteristic(Characteristic.OccupancyDetected)
          .updateValue(state);
        if (self.debug) self.log("[EntryDelaySensor] Occupancy set to:", state);
      });
      entryDelayEmitter.on("error", function (err) {
        self.log("Polling Entry Delay failed:", err);
      });
    }

    // Start built-in keepalive — replaces any external ping requirement
    this.startKeepalive();
  },

  getServices: function () {
    if (this.debug) this.log("Get Services called");
    if (!this.SecuritySystem || !this.EntryDelaySensor) return [];

    const infoService = new Service.AccessoryInformation();
    infoService.setCharacteristic(Characteristic.Manufacturer, "Honeywell-Tuxedo");

    return [infoService, this.SecuritySystem, this.EntryDelaySensor];
  },

  // ---------------------------------------------------------------------------
  // Characteristic handlers (async, Promise-based for Homebridge 2.0)
  // ---------------------------------------------------------------------------

  /**
   * GET SecuritySystemCurrentState
   */
  handleSecuritySystemCurrentStateGet: async function () {
    if (this.debug) this.log("[handleSecuritySystemCurrentStateGet] GET");

    const value = await this._getAlarmMode();
    const statusString = JSON.parse(value).Status.toString().trim();
    let state;

    if (/SECS REMAINING$/i.test(statusString)) {
      // Arming countdown in progress — return last known good state
      state = this.lastValidCurrentState;
      if (this.debug)
        this.log(
          `[CurrentState] Arming countdown: ${statusString}. Returning lastValidCurrentState: ${state}`
        );
    } else if (statusString === "Entry Delay Active") {
      // Entry delay — return last valid armed state
      state = this.lastValidCurrentState;
      if (this.debug)
        this.log(
          "[CurrentState] Entry Delay Active - returning lastValidCurrentState: " + state
        );
    } else {
      state =
        alarmStatus[statusString] === undefined ? 3 : alarmStatus[statusString];
      if (state !== 5) {
        this.lastValidCurrentState = state;
      } else {
        state = this.lastValidCurrentState;
        if (this.debug)
          this.log(
            "[CurrentState] Not available/error, returning last valid state: " +
              this.lastValidCurrentState
          );
      }
    }

    if (
      alarmStatus[statusString] === undefined &&
      !/SECS REMAINING$/i.test(statusString) &&
      statusString !== "Entry Delay Active"
    ) {
      this.log(
        "[handleSecuritySystemCurrentStateGet] Unknown alarm state: " +
          statusString +
          " — please report this via a GitHub issue"
      );
    }

    this.currentState = state;
    return state;
  },

  /**
   * GET SecuritySystemTargetState
   */
  handleSecuritySystemTargetStateGet: async function () {
    if (this.debug) this.log("[handleSecuritySystemTargetStateGet] GET");

    const value = await this._getAlarmMode();
    const statusString = JSON.parse(value).Status.toString().trim();
    let state;

    if (/SECS REMAINING$/i.test(statusString)) {
      state = this.lastTargetState;
      if (this.debug)
        this.log(
          `[handleSecuritySystemTargetStateGet] Arming countdown (${statusString}) - returning lastTargetState: ${state}`
        );
    } else if (statusString === "Entry Delay Active") {
      state = this.lastTargetState;
      if (this.debug)
        this.log(
          "[handleSecuritySystemTargetStateGet] Entry Delay Active - returning lastTargetState: " +
            state
        );
    } else {
      state =
        alarmStatus[statusString] === undefined ? 3 : alarmStatus[statusString];
      // HomeKit does not accept target state 4 (triggered) or 5 (error)
      if (state === 4 || state === 5) {
        state = this.lastTargetState;
      }
    }

    if (
      alarmStatus[statusString] === undefined &&
      !/SECS REMAINING$/i.test(statusString) &&
      statusString !== "Entry Delay Active"
    ) {
      this.log(
        "[handleSecuritySystemTargetStateGet] Unknown alarm state: " +
          statusString +
          " — please report this via a GitHub issue"
      );
    }

    if (this.debug)
      this.log(
        "[handleSecuritySystemTargetStateGet] Returning target state: " + state
      );

    this.targetState = state;
    return state;
  },

  /**
   * SET SecuritySystemTargetState
   */
  handleSecuritySystemTargetStateSet: async function (value) {
    if (this.debug)
      this.log(
        "[handleSecuritySystemTargetStateSet] Triggered SET SecuritySystemTargetState: " +
          value
      );

    if (this.fetchKeysBeforeEverySetCall) {
      if (this.debug)
        this.log(
          "[handleSecuritySystemTargetStateSet] fetchKeysBeforeEverySetCall is true, fetching API keys"
        );
      await this._getAPIKeys();
    }

    this.targetState = value;
    if (value !== 3) this.lastTargetState = value;

    if (value === 0) await this._armAlarm("STAY");
    if (value === 1) await this._armAlarm("AWAY");
    if (value === 2) await this._armAlarm("NIGHT");
    if (value === 3) await this._disarmAlarm();
  },

  /**
   * GET Entry Delay Occupancy
   */
  handleEntryDelayGet: async function () {
    const value = await this._getAlarmMode();
    const statusString = JSON.parse(value).Status.toString().trim();
    return statusString === "Entry Delay Active" ? 1 : 0;
  },

  // ---------------------------------------------------------------------------
  // Keepalive — pings the VAM unit on a timer so no external tool is needed
  // ---------------------------------------------------------------------------

  /**
   * Starts a recurring HTTP ping to the VAM home page.
   *
   * This serves two purposes:
   *   1. Works around a VAM firmware bug where the status API returns stale
   *      data until a browser-like request hits the unit.
   *   2. Monitors connectivity and sets/clears StatusFault accordingly,
   *      removing any need for an external ping/healthcheck tool.
   *
   * Interval is configurable via `keepaliveInterval` in config (ms, default 60000).
   */
  startKeepalive: function () {
    const intervalMs = this.keepaliveInterval;
    this.log("[Keepalive] Starting with interval " + intervalMs + "ms");

    this._keepaliveTimer = setInterval(async () => {
      try {
        var url = protocol + "://" + this.host;
        if (this.port) url += ":" + this.port;
        url += "/home.html";

        if (this.debug) this.log("[Keepalive] Pinging VAM at " + url);

        await got(url, {
          method: "GET",
          timeout: { request: 5000 },
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36",
          },
          https: { rejectUnauthorized: false },
          retry: { limit: 0 }, // don't retry inside keepalive; just wait for next tick
        });

        if (this.debug) this.log("[Keepalive] VAM ping successful");

        // If we were previously faulted due to connectivity, clear it now
        if (this._keepaliveFaulted) {
          this._keepaliveFaulted = false;
          this.SecuritySystem
            .getCharacteristic(Characteristic.StatusFault)
            .updateValue(0);
          this.log("[Keepalive] VAM connectivity restored, clearing fault");
        }
      } catch (error) {
        this.log("[Keepalive] VAM unreachable: " + error.message);
        if (!this._keepaliveFaulted) {
          this._keepaliveFaulted = true;
          this.SecuritySystem
            .getCharacteristic(Characteristic.StatusFault)
            .updateValue(1);
        }
      }
    }, intervalMs);
  },

  /**
   * Stops the keepalive timer. Called automatically on Homebridge shutdown.
   */
  stopKeepalive: function () {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
      this.log("[Keepalive] Stopped");
    }
  },

  // ---------------------------------------------------------------------------
  // Internal API helpers (all Promise-based)
  // ---------------------------------------------------------------------------

  /**
   * Fetches the current alarm status from the VAM unit.
   * Returns the raw JSON string e.g. '{"Status":"Ready To Arm"}'
   */
  _getAlarmMode: async function () {
    var url = protocol + "://" + this.host;
    if (this.port !== "") url += ":" + this.port;
    url += apibasepath + "/GetSecurityStatus";

    if (this.debug) this.log("[_getAlarmMode] Calling: " + url);
    return this._callAPI(url, "");
  },

  /**
   * Arms the alarm in the given mode: STAY | AWAY | NIGHT
   */
  _armAlarm: async function (mode) {
    var pID = 1;
    var queryString =
      "arming=" + mode +
      "&pID=" + pID +
      "&ucode=" + parseInt(this.uCode) +
      "&operation=set";
    var url = protocol + "://" + this.host;
    if (this.port !== "") url += ":" + this.port;
    url += apibasepath + "/AdvancedSecurity/ArmWithCode";

    if (this.debug)
      this.log("[_armAlarm] Calling: " + url + " query: " + queryString);

    await this._callAPI(url, queryString);
  },

  /**
   * Disarms the alarm.
   * VAM does not expose a DisarmWithCode API endpoint; we call the internal
   * web interface handler that the VAM's own UI uses.
   */
  _disarmAlarm: async function () {
    var pID = 1;
    var queryString =
      "cmd=3&Type=3&pID=" + pID + "&uCode=" + parseInt(this.uCode);
    var url = protocol + "://" + this.host;
    if (this.port !== "") url += ":" + this.port;
    url += "/handlerequest.html";

    if (this.debug)
      this.log("[_disarmAlarm] Calling: " + url + " query: " + queryString);

    await this._callAPI(url, queryString);
  },

  /**
   * Core HTTP GET wrapper.
   * The VAM API uses GET with query params for all "POST-like" operations.
   * Throws on network/HTTP error so callers can handle via try/catch or
   * HomeKit's HapStatusError.
   */
  _callAPI: async function (url, data) {
    const fullUrl = data ? url + "?" + data : url;

    if (this.debug) this.log("[_callAPI] Requesting: " + fullUrl);

    try {
      const response = await got.get(fullUrl, {
        https: { rejectUnauthorized: false },
      });

      // The VAM appends a disclaimer HTML block after the JSON — strip it
      const body = response.body;
      const trimmed = body.substring(0, body.lastIndexOf("}") + 1);

      if (this.debug) this.log("[_callAPI] Response: " + trimmed);
      return trimmed;
    } catch (error) {
      this.log("[_callAPI] Error: " + error.message);
      if (this.debug) this.log(error);
      // Return a sentinel so state handlers degrade gracefully
      return '{"Status":"Error"}';
    }
  },

  /**
   * Fetches the VAM home page to refresh internal state.
   * This is also the keepalive mechanism — see startKeepalive().
   */
  _getAPIKeys: async function () {
    this.log("[_getAPIKeys] Refreshing VAM session");
    try {
      var url = protocol + "://" + this.host;
      if (this.port) url += ":" + this.port;
      url += "/home.html";

      if (this.debug) this.log("[_getAPIKeys] Fetching: " + url);

      await got(url, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36",
        },
        https: { rejectUnauthorized: false },
      });
    } catch (error) {
      if (error.code === "EPROTO") {
        this.log(
          "[_getAPIKeys] OpenSSL protocol error — see: https://github.com/lockpicker/homebridge-honeywell-tuxedo-touch/issues/1"
        );
      } else {
        this.log(
          "[_getAPIKeys] Could not reach VAM unit. Ensure 'Authentication for web server local access' is disabled on the unit."
        );
        if (this.debug) this.log(error);
      }
    }
  },
};
