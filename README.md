# homebridge-honeywell-vam
Homebridge plugin for the Honeywell Vista Automation Module.

This plugin exposes the Honeywell VAM Wifi unit as a security system accessory in Homekit through [Homebridge](http://homebridge.io)

VAM is similar to Tuxedo but never made a strong presence and has been abandoned. This is a hacked up fork of a Tuxedo plugin
to work with VAM v6.2.9. It relies on HTTP rather than HTTPS as VAM must use TLS 1.1 which has been obsoleted so virtually
nothing will talk to it anymore. This means the Homebridge plugin must be on the same local network/VNET as the VAM unless
you want to fight with a TLS proxy. Not all unused code has been removed because I built this for personal use.

## Installation

1. Install homebridge using: npm install -g homebridge
2. Install homebridge-honeywell-vam using: npm install https://github.com/MaverickC2/homebridge-honeywell-vam
3. Update your configuration file. See sample-config.json in this repository for a sample.

## Features
This plugin currently only supports the security system feature of the Honeywell Tuxedo Touch unit. It maps the following modes:
<table style='align:center'>
  <tr><td><b>Homekit Mode</b></td><td><b>VAM Mode</b></td></tr>
  <tr><td>Home </td><td>Stay</td></tr>
  <tr><td>Night </td><td>Night</td></tr>
  <tr><td>Away </td><td>Away</td></tr>
  <tr><td>Off </td><td>Disarm</td></tr>
</table>

and the following tuxedo state mappings are applied:
<table style='align:center'>
  <tr><td><b>Tuxedo State</b></td><td><b>Homekit security state</b></td></tr>
  <tr><td>Armed Stay</td><td>Stay</td></tr>
  <tr><td>Armed Stay Fault</td><td>Stay</td></tr>
  <tr><td>Armed Away</td><td>Away</td></tr>
  <tr><td>Armed Away Fault</td><td>Away</td></tr>
  <tr><td>Armed Night</td><td>Night</td></tr>
  <tr><td>Armed Night Fault</td><td>Night</td></tr>
  <tr><td>Armed Instant</td><td>Night</td></tr>
  <tr><td>Armed Instant Fault</td><td>Night</td></tr>
  <tr><td>Ready Fault</td><td>Off</td></tr>
  <tr><td>Ready To Arm</td><td>Off</td></tr>
  <tr><td>Not Ready</td><td>Off</td></tr>
  <tr><td>Not Ready Fault</td><td>Off</td></tr>
  <tr><td>Entry Delay Active</td><td>Moved to an occupancy sensor in v1.5.3 </td></tr>
  <tr><td>Not Ready Alarm</td><td>Triggered</td></tr>
  <tr><td>Armed Stay Alarm</td><td>Triggered</td></tr>
  <tr><td>Armed Night Alarm</td><td>Triggered</td></tr>
  <tr><td>Armed Away Alarm</td><td>Triggered</td></tr>
</table>

There is no available comprehensive list of states documented for the Tuxedo unit so this is compiled based on everything we've seen so far. If the plugin detects a mode not in the list, it will result in disarming the system as assuming any other state will result in a false alarm condition. This will also be logged in the logs. If this happens, please raise a bug through github and the state will be added to the mapping for appropriate handling.


## Configuration
The configuration options are the following:

Minimum options:
```
"accessories": [
  {
    "accessory": "Honeywell Tuxedo Touch",
    "host": "myalarm.ddns.net",
    "alarmCode": "1234"
  }
]

```

All options:
```
"accessories": [
  {
    "name": "Home Security",
    "accessory": "Honeywell Tuxedo Touch",
    "host": "myalarm.ddns.net",
    "port": "8000",
    "alarmCode": "1234",
    "polling": true,
    "pollInterval": 10000,
    "debug": false
  }
]

```

- The **name** parameter is optional and determines the name of the security system you will see in HomeKit.
- The **accessory** parameter tells Homebridge which plugin to load for this accessory. Leave this exactly as described in the example config.
- The **host** parameter accepts the ip address or the hostname of the Tuxedo touch unit.
  Whilst the IP address can be the local LAN ip of the unit, the tuxedo touch unit is sometimes unresponsive when accessed through the lan ip, it seems a lot more reliable when accessed through the WAN interface.
  If you have a static ip which exposes the unit, you can use that, if not, setup a dynamic dns, expose your tuxedo unit through that and use it with this plugin.
  Though note that **if your local LAN IP works reliably, that should be your first preference**.
- The **port** parameter is optional and accepts the port number of the host on which the Tuxedo touch unit is available. The tuxedo API only responds over the https port(443), so if you're using port forwarding, remember to use the port that forwards to 443 on the tuxedo unit.
- The **alarmCode** parameter accepts your security alarm code for arming and disarming the security system.
- The **polling** is a boolean that specifies if the current state should be pulled on regular intervals or not.
  This is optional and defaults to false however using this is recommended as it will keep your Homekit status synced with the unit if the state changes outside of a Homekit operation.
- **pollInterval** is a number which defines the poll interval in milliseconds. Defaults to 30000.
- The **debug** parameter is boolean and turns on debug messages.

## Troubleshooting tips
- Make sure to disable "Authentication for web server local access" from the accounts screen under settings on the tuxedo unit.
- If the alarm disarms itself without any operation from the user(s), check to see if your tuxedo unit is displaying a state which isn'tn in the state mapping provided above and report that through an issue on github. This will also be logged in the homebridge logs.

## FAQ
- Node may throw the following warning
  ```
  Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.
  ```
  This is because the Tuxedo units come with really old certs which aren't trusted anymore, without any way to upgrade these certs, the workaround is to not check the cert.
- Why is this not a platform accessory and/or why does it not support the other devices controlled by tuxedo? <br>
  The tuxedo API has many bugs including a significant issue of not returning all devices controlled by the unit. The device api seems to only return the first device connected to the unit and not all. Given enough time and motivation, this can be achieved through the workaround of scraping the web interface.

## Credits
Forked from [https://github.com/lockpicker/homebridge-honeywell-tuxedo-touch](https://github.com/lockpicker/homebridge-honeywell-tuxedo-touch)
