/*
 * TerraNurture - ESP32 IoT Irrigation Controller
 * Simplified Stable Version
 */

#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <stdarg.h>   // ✅ REQUIRED for debug_log
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>


// ============ CONFIGURATION ============
#define ADC_PIN 34
#define RELAY_PIN 25
#define RELAY_ACTIVE_HIGH 0

#define DEFAULT_DRY_THRESHOLD 45.0
#define DEFAULT_EXPECTED_VALUE 60.0
#define DEFAULT_MAX_RETRIES 3
#define DEFAULT_SAMPLING_INTERVAL 3000
#define DEFAULT_ADC_DRY 4095
#define DEFAULT_ADC_WET 1500

const char* ssid = "Amrit";
const char* password = "kali@254";

// System constants
#define LOG_QUEUE_SIZE 50
#define WS_PORT 81
#define HTTP_PORT 80
#define LOG_FILE "/logs.csv"
#define CONFIG_FILE "/config.json"

// ============ GLOBAL STATE ============
typedef struct {
  uint32_t timestamp;
  int raw_adc;
  float percentage;
  char event[32];
  char details[64];
} LogEntry;

typedef struct {
  float moisture;
  uint32_t timestamp;
  bool valid;
  int raw_adc;
} SensorReading;

typedef struct {
  bool pump_active;
  uint8_t retry_count;
  char status[32];
  uint32_t last_change;
} PumpState;

typedef struct {
  float dry_threshold;
  float expected_value;
  uint8_t max_retries;
  uint32_t sampling_interval;
  int adc_dry;
  int adc_wet;
} SystemConfig;

SemaphoreHandle_t xMutex = NULL;
SensorReading current_reading = {0.0, 0, false, 0};
PumpState pump_state = {false, 0, "IDLE", 0};
SystemConfig config = {
  DEFAULT_DRY_THRESHOLD,
  DEFAULT_EXPECTED_VALUE,
  DEFAULT_MAX_RETRIES,
  DEFAULT_SAMPLING_INTERVAL,
  DEFAULT_ADC_DRY,
  DEFAULT_ADC_WET
};

bool wifi_connected = false;
bool fs_available = false;
bool ota_enabled = false;

QueueHandle_t log_queue = NULL;
QueueHandle_t pump_command_queue = NULL;

WebServer server(HTTP_PORT);
WebSocketsServer webSocket(WS_PORT);

// ============ DEBUG LOGGING ============
void debug_log(const char* tag, const char* format, ...) {
  char buffer[256];
  va_list args;
  va_start(args, format);
  vsnprintf(buffer, sizeof(buffer), format, args);
  va_end(args);
  
  Serial.printf("[%s] %s\n", tag, buffer);
}

// ============ CALIBRATION FUNCTIONS ============
float map_adc_to_percentage(int raw_adc) {
  if (raw_adc < 0 || raw_adc > 4095) return 0.0;
  
  // Check if calibration values are valid
  if (config.adc_dry <= config.adc_wet) {
    return 0.0;
  }
  
  if (raw_adc <= config.adc_wet) return 100.0;
  if (raw_adc >= config.adc_dry) return 0.0;
  
  float percentage = 100.0 * (1.0 - (float)(raw_adc - config.adc_wet) / (float)(config.adc_dry - config.adc_wet));
  return constrain(percentage, 0.0, 100.0);
}

// ============ CONFIGURATION MANAGEMENT ============
bool saveConfig() {
  if (!fs_available) return false;
  
  JsonDocument doc;
  doc["dry_threshold"] = config.dry_threshold;
  doc["expected_value"] = config.expected_value;
  doc["max_retries"] = config.max_retries;
  doc["sampling_interval"] = config.sampling_interval;
  doc["adc_dry"] = config.adc_dry;
  doc["adc_wet"] = config.adc_wet;
  
  File file = LittleFS.open(CONFIG_FILE, FILE_WRITE);
  if (!file) return false;
  
  serializeJson(doc, file);
  file.close();
  
  debug_log("CONFIG", "Configuration saved");
  return true;
}

bool loadConfig() {
  if (!fs_available) return false;
  
  if (!LittleFS.exists(CONFIG_FILE)) {
    debug_log("CONFIG", "No config file, using defaults");
    return saveConfig();
  }
  
  File file = LittleFS.open(CONFIG_FILE, FILE_READ);
  if (!file) return false;
  
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, file);
  file.close();
  
  if (error) {
    debug_log("CONFIG", "Failed to parse config");
    return false;
  }
  
  config.dry_threshold = doc["dry_threshold"] | DEFAULT_DRY_THRESHOLD;
  config.expected_value = doc["expected_value"] | DEFAULT_EXPECTED_VALUE;
  config.max_retries = doc["max_retries"] | DEFAULT_MAX_RETRIES;
  config.sampling_interval = doc["sampling_interval"] | DEFAULT_SAMPLING_INTERVAL;
  config.adc_dry = doc["adc_dry"] | DEFAULT_ADC_DRY;
  config.adc_wet = doc["adc_wet"] | DEFAULT_ADC_WET;
  
  debug_log("CONFIG", "Configuration loaded");
  return true;
}

// ============ WEB SOCKET FUNCTIONS ============
void webSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      debug_log("WS", "Client %u disconnected", num);
      break;
      
    case WStype_CONNECTED: {
      IPAddress ip = webSocket.remoteIP(num);
      debug_log("WS", "Client %u connected from %s", num, ip.toString().c_str());
      break;
    }
      
    case WStype_TEXT:
      debug_log("WS", "Received: %s", payload);
      break;
  }
}

void sendStateToClient(uint8_t client) {
  JsonDocument doc;
  
  // Get sensor data safely
  float moisture = 0.0;
  int raw_adc = 0;
  bool valid = false;
  uint32_t sensor_timestamp = 0;
  
  if (xSemaphoreTake(xMutex, portMAX_DELAY) == pdTRUE) {
    moisture = current_reading.moisture;
    raw_adc = current_reading.raw_adc;
    valid = current_reading.valid;
    sensor_timestamp = current_reading.timestamp;
    xSemaphoreGive(xMutex);
  }
  
  doc["type"] = "state";
  
  // Sensor data
  JsonObject sensor = doc["sensor"].to<JsonObject>();
  sensor["moisture"] = moisture;
  sensor["raw_adc"] = raw_adc;
  sensor["timestamp"] = sensor_timestamp;
  sensor["valid"] = valid;
  
  // Calibration data
  JsonObject cal = doc["calibration"].to<JsonObject>();
  cal["adc_dry"] = config.adc_dry;
  cal["adc_wet"] = config.adc_wet;
  cal["threshold"] = config.dry_threshold;
  cal["target"] = config.expected_value;
  
  // Network data
  JsonObject network = doc["network"].to<JsonObject>();
  network["connected"] = wifi_connected;
  network["ip"] = WiFi.localIP().toString();
  network["mac"] = WiFi.macAddress();
  network["gateway"] = WiFi.gatewayIP().toString();
  network["subnet"] = WiFi.subnetMask().toString();
  network["dns"] = WiFi.dnsIP().toString();
  network["ssid"] = WiFi.SSID();
  network["rssi"] = WiFi.RSSI();
  
  // System data
  JsonObject system = doc["system"].to<JsonObject>();
  system["uptime"] = millis();
  system["free_heap"] = ESP.getFreeHeap();
  system["fs_available"] = fs_available;
  system["build_date"] = __DATE__ " " __TIME__;
  
  String json;
  serializeJson(doc, json);
  webSocket.sendTXT(client, json);
}

void broadcastState() {
  JsonDocument doc;
  
  // Get sensor data safely
  float moisture = 0.0;
  int raw_adc = 0;
  bool valid = false;
  uint32_t sensor_timestamp = 0;
  
  if (xSemaphoreTake(xMutex, portMAX_DELAY) == pdTRUE) {
    moisture = current_reading.moisture;
    raw_adc = current_reading.raw_adc;
    valid = current_reading.valid;
    sensor_timestamp = current_reading.timestamp;
    xSemaphoreGive(xMutex);
  }
  
  doc["type"] = "state";
  
  // Sensor data
  JsonObject sensor = doc["sensor"].to<JsonObject>();
  sensor["moisture"] = moisture;
  sensor["raw_adc"] = raw_adc;
  sensor["timestamp"] = sensor_timestamp;
  sensor["valid"] = valid;
  
  // Pump data
  JsonObject pump = doc["pump"].to<JsonObject>();
  pump["active"] = pump_state.pump_active;
  pump["status"] = pump_state.status;
  pump["retry_count"] = pump_state.retry_count;
  pump["last_change"] = pump_state.last_change;
  
  // Calibration data
  JsonObject cal = doc["calibration"].to<JsonObject>();
  cal["adc_dry"] = config.adc_dry;
  cal["adc_wet"] = config.adc_wet;
  cal["threshold"] = config.dry_threshold;
  cal["target"] = config.expected_value;
  
  // Network data
  JsonObject network = doc["network"].to<JsonObject>();
  network["connected"] = wifi_connected;
  network["ip"] = WiFi.localIP().toString();
  network["mac"] = WiFi.macAddress();
  network["gateway"] = WiFi.gatewayIP().toString();
  network["subnet"] = WiFi.subnetMask().toString();
  network["dns"] = WiFi.dnsIP().toString();
  network["ssid"] = WiFi.SSID();
  network["rssi"] = WiFi.RSSI();
  
  // System data
  JsonObject system = doc["system"].to<JsonObject>();
  system["uptime"] = millis();
  system["free_heap"] = ESP.getFreeHeap();
  system["fs_available"] = fs_available;
  system["build_date"] = __DATE__ " " __TIME__;
  
  String json;
  serializeJson(doc, json);
  webSocket.broadcastTXT(json);
}

// ============ SENSOR TASK ============
void sensor_task(void* pvParameters) {
  debug_log("SENSOR", "Task started");
  
  while(1) {
    int raw_adc = analogRead(ADC_PIN);
    
    // Check if sensor is connected (reasonable ADC range)
    bool sensor_connected = (raw_adc > 100 && raw_adc < 4000);
    float percentage = map_adc_to_percentage(raw_adc);
    uint32_t timestamp = millis();
    
    if (xSemaphoreTake(xMutex, portMAX_DELAY) == pdTRUE) {
      if (sensor_connected) {
        current_reading.moisture = percentage;
        current_reading.valid = true;
      } else {
        current_reading.moisture = 0.0;
        current_reading.valid = false;
      }
      current_reading.timestamp = timestamp;
      current_reading.raw_adc = raw_adc;
      xSemaphoreGive(xMutex);
    }
    
    // Log sensor reading
    LogEntry entry;
    entry.timestamp = timestamp;
    entry.raw_adc = raw_adc;
    entry.percentage = percentage;
    strcpy(entry.event, "SENSOR_READ");
    strcpy(entry.details, sensor_connected ? "OK" : "DISCONNECTED");
    
    xQueueSend(log_queue, &entry, 0);
    
    vTaskDelay(pdMS_TO_TICKS(config.sampling_interval));
  }
}

// ============ PUMP TASK ============
void pump_task(void* pvParameters) {
  debug_log("PUMP", "Task started");
  
  while(1) {
    // Check for manual pump commands
    bool command = false;
    if (xQueueReceive(pump_command_queue, &command, 0) == pdTRUE && command) {
      debug_log("PUMP", "Manual activation");
      
      // Log pump start
      LogEntry startEntry;
      startEntry.timestamp = millis();
      startEntry.raw_adc = current_reading.raw_adc;
      startEntry.percentage = current_reading.moisture;
      strcpy(startEntry.event, "PUMP_MANUAL_START");
      strcpy(startEntry.details, "Manual activation");
      xQueueSend(log_queue, &startEntry, 0);
      
      // Activate pump
      digitalWrite(RELAY_PIN, RELAY_ACTIVE_HIGH ? HIGH : LOW);
      if (xSemaphoreTake(xMutex, portMAX_DELAY) == pdTRUE) {
        pump_state.pump_active = true;
        pump_state.last_change = millis();
        strcpy(pump_state.status, "MANUAL");
        xSemaphoreGive(xMutex);
      }
      
      vTaskDelay(pdMS_TO_TICKS(5000));
      
      // Deactivate pump
      digitalWrite(RELAY_PIN, RELAY_ACTIVE_HIGH ? LOW : HIGH);
      if (xSemaphoreTake(xMutex, portMAX_DELAY) == pdTRUE) {
        pump_state.pump_active = false;
        pump_state.last_change = millis();
        strcpy(pump_state.status, "IDLE");
        xSemaphoreGive(xMutex);
      }
      
      // Log pump stop
      LogEntry stopEntry;
      stopEntry.timestamp = millis();
      stopEntry.raw_adc = current_reading.raw_adc;
      stopEntry.percentage = current_reading.moisture;
      strcpy(stopEntry.event, "PUMP_MANUAL_STOP");
      strcpy(stopEntry.details, "Manual completed");
      xQueueSend(log_queue, &stopEntry, 0);
      
      debug_log("PUMP", "Manual cycle complete");
    }
    
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// ============ WEB SERVER HANDLERS ============
void handleGetState() {
  JsonDocument doc;
  
  // Get sensor data safely
  float moisture = 0.0;
  int raw_adc = 0;
  bool valid = false;
  uint32_t sensor_timestamp = 0;
  
  if (xSemaphoreTake(xMutex, portMAX_DELAY) == pdTRUE) {
    moisture = current_reading.moisture;
    raw_adc = current_reading.raw_adc;
    valid = current_reading.valid;
    sensor_timestamp = current_reading.timestamp;
    xSemaphoreGive(xMutex);
  }
  
  // Sensor data
  doc["sensor"]["moisture"] = moisture;
  doc["sensor"]["raw_adc"] = raw_adc;
  doc["sensor"]["timestamp"] = sensor_timestamp;
  doc["sensor"]["valid"] = valid;
  
  // Pump data
  doc["pump"]["active"] = pump_state.pump_active;
  doc["pump"]["status"] = pump_state.status;
  doc["pump"]["retry_count"] = pump_state.retry_count;
  doc["pump"]["last_change"] = pump_state.last_change;
  
  // Calibration data
  doc["calibration"]["adc_dry"] = config.adc_dry;
  doc["calibration"]["adc_wet"] = config.adc_wet;
  doc["calibration"]["threshold"] = config.dry_threshold;
  doc["calibration"]["target"] = config.expected_value;
  
  // Network data
  doc["network"]["connected"] = wifi_connected;
  doc["network"]["ip"] = WiFi.localIP().toString();
  doc["network"]["mac"] = WiFi.macAddress();
  doc["network"]["gateway"] = WiFi.gatewayIP().toString();
  doc["network"]["subnet"] = WiFi.subnetMask().toString();
  doc["network"]["dns"] = WiFi.dnsIP().toString();
  doc["network"]["ssid"] = WiFi.SSID();
  doc["network"]["rssi"] = WiFi.RSSI();
  
  // System data
  doc["system"]["uptime"] = millis();
  doc["system"]["free_heap"] = ESP.getFreeHeap();
  doc["system"]["fs_available"] = fs_available;
  doc["system"]["build_date"] = __DATE__ " " __TIME__;
  
  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleManualPump() {
  bool command = true;
  xQueueSend(pump_command_queue, &command, 0);
  
  JsonDocument doc;
  doc["status"] = "manual_pump_triggered";
  doc["timestamp"] = millis();
  
  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleCalibrate() {
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No data\"}");
    return;
  }
  
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, server.arg("plain"));
  
  if (error) {
    server.send(400, "application/json", "{\"error\":\"Parse error\"}");
    return;
  }
  
  String type = doc["type"];
  int current_adc = analogRead(ADC_PIN);
  
  if (type == "dry") {
    config.adc_dry = current_adc;
  } else if (type == "wet") {
    config.adc_wet = current_adc;
  } else {
    server.send(400, "application/json", "{\"error\":\"Invalid type\"}");
    return;
  }
  
  saveConfig();
  
  JsonDocument response;
  response["status"] = "calibration_saved";
  response["type"] = type;
  response["adc_value"] = current_adc;
  response["timestamp"] = millis();
  
  String json;
  serializeJson(response, json);
  server.send(200, "application/json", json);
}

void handleUpdateConfig() {
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No data\"}");
    return;
  }
  
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, server.arg("plain"));
  
  if (error) {
    server.send(400, "application/json", "{\"error\":\"Parse error\"}");
    return;
  }
  
  if (doc.containsKey("dry_threshold")) {
    config.dry_threshold = doc["dry_threshold"];
    config.dry_threshold = constrain(config.dry_threshold, 0.0, 100.0);
  }
  
  if (doc.containsKey("expected_value")) {
    config.expected_value = doc["expected_value"];
    config.expected_value = constrain(config.expected_value, 0.0, 100.0);
  }
  
  if (doc.containsKey("max_retries")) {
    config.max_retries = doc["max_retries"];
    config.max_retries = constrain(config.max_retries, 1, 10);
  }
  
  if (doc.containsKey("sampling_interval")) {
    config.sampling_interval = doc["sampling_interval"];
    config.sampling_interval = constrain(config.sampling_interval, 1000, 60000);
  }
  
  saveConfig();
  
  JsonDocument response;
  response["status"] = "config_updated";
  response["timestamp"] = millis();
  
  String json;
  serializeJson(response, json);
  server.send(200, "application/json", json);
}

void handleGetLogs() {
  if (!fs_available || !LittleFS.exists(LOG_FILE)) {
    server.send(200, "application/json", "[]");
    return;
  }
  
  File file = LittleFS.open(LOG_FILE, FILE_READ);
  if (!file) {
    server.send(500, "application/json", "{\"error\":\"Failed to open log file\"}");
    return;
  }
  
  // Read logs and convert to JSON array
  String json = "[";
  bool firstLine = true;
  
  // Skip header
  file.readStringUntil('\n');
  
  while (file.available()) {
    String line = file.readStringUntil('\n');
    line.trim();
    
    if (line.length() == 0) continue;
    
    int comma1 = line.indexOf(',');
    int comma2 = line.indexOf(',', comma1 + 1);
    int comma3 = line.indexOf(',', comma2 + 1);
    
    if (comma1 == -1 || comma2 == -1 || comma3 == -1) continue;
    
    String timestamp = line.substring(0, comma1);
    String raw_adc = line.substring(comma1 + 1, comma2);
    String percentage = line.substring(comma2 + 1, comma3);
    String event = line.substring(comma3 + 1);
    
    if (!firstLine) json += ",";
    firstLine = false;
    
    json += "{";
    json += "\"timestamp\":" + timestamp + ",";
    json += "\"raw_adc\":" + raw_adc + ",";
    json += "\"percentage\":" + percentage + ",";
    json += "\"event\":\"" + event + "\"";
    json += "}";
  }
  
  file.close();
  json += "]";
  
  server.send(200, "application/json", json);
}

void handleDownloadLogs() {
  if (!fs_available) {
    server.send(500, "text/plain", "Filesystem not available");
    return;
  }
  
  if (!LittleFS.exists(LOG_FILE)) {
    server.send(404, "text/plain", "No logs available");
    return;
  }
  
  File file = LittleFS.open(LOG_FILE, FILE_READ);
  if (!file) {
    server.send(500, "text/plain", "Failed to open log file");
    return;
  }
  
  server.sendHeader("Content-Type", "text/csv");
  server.sendHeader("Content-Disposition", "attachment; filename=terra_logs.csv");
  server.streamFile(file, "text/csv");
  file.close();
}

void handleClearLogs() {
  if (!fs_available) {
    server.send(500, "application/json", "{\"error\":\"Filesystem not available\"}");
    return;
  }
  
  LittleFS.remove(LOG_FILE);
  
  // Recreate log file with header
  File file = LittleFS.open(LOG_FILE, FILE_WRITE);
  if (file) {
    file.println("timestamp,raw_adc,percentage,event");
    file.close();
  }
  
  JsonDocument doc;
  doc["status"] = "logs_cleared";
  doc["timestamp"] = millis();
  
  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleNotFound() {
  server.send(404, "text/plain", "File not found");
}

// ============ WEB SERVER TASK ============
void web_task(void* pvParameters) {
  debug_log("WEB", "Task started");
  
  // Initialize LittleFS
  delay(1000);
  
  if (!LittleFS.begin(true)) {
    debug_log("WEB", "LittleFS initialization failed");
    fs_available = false;
  } else {
    fs_available = true;
    debug_log("WEB", "LittleFS initialized");
    
    // Load configuration
    loadConfig();
    
    // Create log file with header if it doesn't exist
    if (!LittleFS.exists(LOG_FILE)) {
      File file = LittleFS.open(LOG_FILE, FILE_WRITE);
      if (file) {
        file.println("timestamp,raw_adc,percentage,event");
        file.close();
        debug_log("WEB", "Created new log file");
      }
    }
  }
  
  // Static file handlers
  server.on("/", HTTP_GET, []() {
    if (!fs_available) {
      server.send(500, "text/plain", "Filesystem not available");
      return;
    }
    
    File file = LittleFS.open("/index.html", FILE_READ);
    if (!file) {
      server.send(500, "text/plain", "index.html not found");
      return;
    }
    
    server.streamFile(file, "text/html");
    file.close();
  });
  
  server.on("/css/styles.css", HTTP_GET, []() {
    if (!fs_available) {
      server.send(500, "text/plain", "Filesystem not available");
      return;
    }
    
    File file = LittleFS.open("/css/styles.css", FILE_READ);
    if (!file) {
      server.send(404, "text/plain", "File not found");
      return;
    }
    
    server.streamFile(file, "text/css");
    file.close();
  });
  
  server.on("/js/app.js", HTTP_GET, []() {
    if (!fs_available) {
      server.send(500, "text/plain", "Filesystem not available");
      return;
    }
    
    File file = LittleFS.open("/js/app.js", FILE_READ);
    if (!file) {
      server.send(404, "text/plain", "File not found");
      return;
    }
    
    server.streamFile(file, "application/javascript");
    file.close();
  });
  
  // API Endpoints
  server.on("/api/state", HTTP_GET, handleGetState);
  server.on("/api/pump/manual", HTTP_POST, handleManualPump);
  server.on("/api/calibrate", HTTP_POST, handleCalibrate);
  server.on("/api/config", HTTP_POST, handleUpdateConfig);
  server.on("/api/logs", HTTP_GET, handleGetLogs);
  server.on("/api/logs/download", HTTP_GET, handleDownloadLogs);
  server.on("/api/logs/clear", HTTP_POST, handleClearLogs);
  
  server.onNotFound(handleNotFound);
  
  // Start servers
  server.begin();
  webSocket.begin();
  webSocket.onEvent(webSocketEvent);
  
  debug_log("WEB", "HTTP server started on port %d", HTTP_PORT);
  debug_log("WEB", "WebSocket server started on port %d", WS_PORT);
  
  // Main loop
  while (1) {
    server.handleClient();
    webSocket.loop();
    
    // Broadcast state every 2 seconds
    static uint32_t lastBroadcast = 0;
    if (millis() - lastBroadcast > 2000) {
      lastBroadcast = millis();
      broadcastState();
    }
    
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// ============ LOGGER TASK ============
void logger_task(void* pvParameters) {
  debug_log("LOGGER", "Task started");
  
  while (1) {
    LogEntry entry;
    if (xQueueReceive(log_queue, &entry, portMAX_DELAY) == pdTRUE) {
      // Print to serial
      Serial.printf("[%lu] %s - ADC: %d, %%: %.1f", 
                   entry.timestamp, entry.event, entry.raw_adc, entry.percentage);
      if (strlen(entry.details) > 0) {
        Serial.printf(" (%s)", entry.details);
      }
      Serial.println();
      
      // Save to LittleFS
      if (fs_available) {
        File file = LittleFS.open(LOG_FILE, FILE_APPEND);
        if (file) {
          file.printf("%lu,%d,%.2f,%s\n", 
                     entry.timestamp, entry.raw_adc, entry.percentage, entry.event);
          file.close();
        }
      }
    }
    taskYIELD();
  }
}

// ============ WIFI TASK ============
void wifi_task(void* pvParameters) {
  debug_log("WIFI", "Task started");
  
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  
  int retries = 0;
  
  while (1) {
    if (WiFi.status() == WL_CONNECTED) {
      if (!wifi_connected) {
        wifi_connected = true;
        debug_log("WIFI", "Connected! IP: %s", WiFi.localIP().toString().c_str());
        
        LogEntry entry;
        entry.timestamp = millis();
        entry.raw_adc = 0;
        entry.percentage = 0.0;
        strcpy(entry.event, "WIFI_CONNECTED");
        strcpy(entry.details, "");
        xQueueSend(log_queue, &entry, 0);
      }
      retries = 0;
    } else {
      if (wifi_connected) {
        wifi_connected = false;
        debug_log("WIFI", "Disconnected!");
        
        LogEntry entry;
        entry.timestamp = millis();
        entry.raw_adc = 0;
        entry.percentage = 0.0;
        strcpy(entry.event, "WIFI_DISCONNECTED");
        strcpy(entry.details, "");
        xQueueSend(log_queue, &entry, 0);
      }
      
      retries++;
      int delay_ms = min(1000 * (1 << min(retries, 6)), 30000);
      debug_log("WIFI", "Reconnecting in %d ms (attempt %d)", delay_ms, retries);
      vTaskDelay(pdMS_TO_TICKS(delay_ms));
      
      WiFi.disconnect();
      vTaskDelay(pdMS_TO_TICKS(100));
      WiFi.begin(ssid, password);
    }
    
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

// ============ SETUP ============
void setup() {
  Serial.begin(115200);
  delay(2000);
  
  Serial.println("\n\n========================================");
  Serial.println("     TerraNurture Irrigation System");
  Serial.println("     Simplified Stable Version");
  Serial.println("========================================");
  Serial.printf("Build Date: %s %s\n", __DATE__, __TIME__);
  
  // Initialize hardware
  pinMode(ADC_PIN, INPUT);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_HIGH ? LOW : HIGH);
  
  // Create mutex
  xMutex = xSemaphoreCreateMutex();
  
  // Create queues
  log_queue = xQueueCreate(LOG_QUEUE_SIZE, sizeof(LogEntry));
  pump_command_queue = xQueueCreate(5, sizeof(bool));
  
  // Create tasks with larger stack sizes
  xTaskCreatePinnedToCore(wifi_task, "WiFi", 8192, NULL, 1, NULL, 1);
  xTaskCreatePinnedToCore(sensor_task, "Sensor", 8192, NULL, 2, NULL, 1);
  xTaskCreatePinnedToCore(pump_task, "Pump", 8192, NULL, 3, NULL, 1);
  xTaskCreatePinnedToCore(web_task, "Web", 16384, NULL, 2, NULL, 0);
  xTaskCreatePinnedToCore(logger_task, "Logger", 8192, NULL, 1, NULL, 0);
  
  // Initial log
  LogEntry entry;
  entry.timestamp = millis();
  entry.raw_adc = 0;
  entry.percentage = 0.0;
  strcpy(entry.event, "SYSTEM_STARTED");
  strcpy(entry.details, "System initialized");
  xQueueSend(log_queue, &entry, 0);
  
  debug_log("SETUP", "System initialized. Tasks created.");
  debug_log("SETUP", "ADC Pin: %d, Relay Pin: %d", ADC_PIN, RELAY_PIN);
}

void loop() {
  vTaskDelete(NULL);
}