const { spawn } = require("child_process");

const SERVER_HEALTH_URL = "http://127.0.0.1:3000/health";
const CLIENT_HEALTH_URL = "http://127.0.0.1:4173/";
const CHECK_INTERVAL_MS = 10_000;
const MAX_FAIL_STREAK = 3;
const RESTART_DELAY_MS = 2_000;

let shuttingDown = false;

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function createService(name, args) {
  return {
    name,
    args,
    proc: null,
    failStreak: 0,
    restartTimer: null
  };
}

const server = createService("server", ["run", "start", "--prefix", "server"]);
const client = createService("client", [
  "run",
  "preview",
  "--prefix",
  "client",
  "--",
  "--host",
  "127.0.0.1",
  "--port",
  "4173"
]);

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[watchdog ${ts}] ${msg}\n`);
}

function startService(service) {
  if (shuttingDown || service.proc) {
    return;
  }

  log(`Starting ${service.name}...`);
  const child = spawn(npmCommand(), service.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: true
  });

  service.proc = child;

  child.on("exit", (code, signal) => {
    service.proc = null;
    if (shuttingDown) {
      return;
    }
    log(`${service.name} exited (code=${code ?? "null"}, signal=${signal ?? "null"}). Restarting...`);
    scheduleRestart(service);
  });

  child.on("error", (error) => {
    log(`${service.name} process error: ${error.message}`);
  });
}

function stopService(service) {
  if (!service.proc) {
    return;
  }
  try {
    service.proc.kill("SIGTERM");
  } catch (_error) {
    // no-op
  }
}

function restartService(service, reason) {
  if (shuttingDown) {
    return;
  }
  log(`Restarting ${service.name}: ${reason}`);
  stopService(service);
  scheduleRestart(service);
}

function scheduleRestart(service) {
  if (shuttingDown || service.restartTimer) {
    return;
  }
  service.restartTimer = setTimeout(() => {
    service.restartTimer = null;
    startService(service);
  }, RESTART_DELAY_MS);
}

async function checkHealth(service, url) {
  if (!service.proc) {
    scheduleRestart(service);
    return;
  }

  try {
    const response = await fetch(url, { method: "GET", cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    service.failStreak = 0;
  } catch (error) {
    service.failStreak += 1;
    log(`${service.name} health check failed (${service.failStreak}/${MAX_FAIL_STREAK}): ${error.message}`);
    if (service.failStreak >= MAX_FAIL_STREAK) {
      service.failStreak = 0;
      restartService(service, "health check timeout/failure");
    }
  }
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log(`Received ${signal}. Stopping services...`);

  [server, client].forEach((service) => {
    if (service.restartTimer) {
      clearTimeout(service.restartTimer);
      service.restartTimer = null;
    }
    stopService(service);
  });

  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startService(server);
startService(client);

setInterval(() => {
  checkHealth(server, SERVER_HEALTH_URL);
  checkHealth(client, CLIENT_HEALTH_URL);
}, CHECK_INTERVAL_MS);

log("Watchdog is running. It will auto-restart web services if they stop unexpectedly.");
