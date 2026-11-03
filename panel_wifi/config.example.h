#pragma once

// Optional static WiFi (otherwise WiFiManager captive portal is used).
// Copy to config.h and fill in — config.h is gitignored.

// #define WIFI_SSID "YourNetwork"
// #define WIFI_PASS "YourPassword"

// mDNS hostname → http://ledpanel.local
#define PANEL_HOSTNAME "ledpanel"

// Default brightness 0..255 (overridable via API / auto mode)
#define BRIGHTNESS_DEFAULT 70

// Timezone: CET/CEST (Slovakia). Change if needed.
#define NTP_TZ "CET-1CEST,M3.5.0,M10.5.0/3"
#define NTP_SERVER "pool.ntp.org"
