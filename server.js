const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const PUBLIC_DIR = path.join(__dirname, "public");
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SCHOOL = {
  lat: Number(process.env.SCHOOL_LAT || 0),
  lng: Number(process.env.SCHOOL_LNG || 0),
  radiusMeters: Number(process.env.ALLOWED_RADIUS_METERS || 1000)
};
const MAX_ACCURACY_METERS = Number(process.env.MAX_ACCURACY_METERS || 300);
const CHECKIN_INTERVAL_MINUTES = Number(process.env.CHECKIN_INTERVAL_MINUTES || 30);
const CHECKIN_GRACE_MINUTES = Number(process.env.CHECKIN_GRACE_MINUTES || 5);
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Sunucu hatasi olustu." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Ogrenci takip sistemi hazir: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      school: SCHOOL,
      checkin: {
        intervalMinutes: CHECKIN_INTERVAL_MINUTES,
        graceMinutes: CHECKIN_GRACE_MINUTES
      },
      sheetsReady: Boolean(SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readJson(req);
    if (body.password !== ADMIN_PASSWORD) {
      sendJson(res, 401, { error: "Admin sifresi hatali." });
      return;
    }
    sendJson(res, 200, { token: signToken({ role: "admin" }) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/students") {
    requireAdmin(req);
    const body = await readJson(req);
    const code = cleanCode(body.code);
    const name = cleanText(body.name);
    const password = String(body.password || "");
    if (!code || !name || password.length < 4) {
      sendJson(res, 400, { error: "Kod, ad soyad ve en az 4 karakter sifre gerekli." });
      return;
    }
    await ensureWorkbook();
    const students = await getStudents();
    if (students.some((student) => student.code === code)) {
      sendJson(res, 409, { error: "Bu ogrenci kodu zaten var." });
      return;
    }
    await sheetsAppend("Students!A:G", [[code, name, hashPassword(password), "", "active", new Date().toISOString(), ""]]);
    await ensureStudentSheet(code, name);
    sendJson(res, 201, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/events") {
    requireAdmin(req);
    await ensureWorkbook();
    await auditAllMissedCheckins();
    const events = await sheetsValues("Events!A:J");
    sendJson(res, 200, { events: rowsToObjects(events).slice(-100).reverse() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/student/login") {
    const body = await readJson(req);
    const code = cleanCode(body.code);
    const password = String(body.password || "");
    const deviceId = cleanText(body.deviceId);
    if (!code || !password || !deviceId) {
      sendJson(res, 400, { error: "Ogrenci kodu, sifre ve cihaz bilgisi gerekli." });
      return;
    }
    await ensureWorkbook();
    const student = await findStudent(code);
    if (!student || student.status !== "active" || !verifyPassword(password, student.passwordHash)) {
      sendJson(res, 401, { error: "Ogrenci bilgileri hatali." });
      return;
    }
    if (student.deviceId && student.deviceId !== deviceId) {
      sendJson(res, 403, { error: "Bu hesap farkli bir cihaza bagli. Admin ile gorusun." });
      return;
    }
    if (!student.deviceId) {
      await updateStudentDevice(student.rowNumber, deviceId);
    }
    sendJson(res, 200, { token: signToken({ role: "student", code }), name: student.name, code });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/student/me") {
    const session = requireStudent(req);
    await ensureWorkbook();
    const student = await findStudent(session.code);
    if (student) await auditMissedCheckins(student);
    const events = await sheetsValues(`Student_${session.code}!A:H`).catch(() => []);
    sendJson(res, 200, {
      code: session.code,
      name: student ? student.name : session.code,
      openEntry: await getOpenEntry(session.code),
      checkin: await getCheckinStatus(session.code),
      rows: rowsToObjects(events).slice(-60).reverse()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/student/event") {
    const session = requireStudent(req);
    const body = await readJson(req);
    const requestedType = body.type === "checkin" ? "checkin" : body.type === "auto_out" ? "auto_out" : body.type === "out" ? "out" : "in";
    const type = requestedType;
    const position = normalizePosition(body.position);
    const deviceId = cleanText(body.deviceId);
    const accuracy = Number(position.accuracy || 0);
    if (!deviceId) {
      sendJson(res, 400, { error: "Cihaz bilgisi eksik." });
      return;
    }
    const student = await findStudent(session.code);
    if (!student || student.deviceId !== deviceId) {
      sendJson(res, 403, { error: "Cihaz dogrulanamadi." });
      return;
    }
    const distance = distanceMeters(position.lat, position.lng, SCHOOL.lat, SCHOOL.lng);
    if (type !== "auto_out" && (!Number.isFinite(distance) || distance > SCHOOL.radiusMeters)) {
      sendJson(res, 403, { error: `Okula ${Math.round(distance)} metre uzaktasiniz. Giris/cikis icin en fazla ${SCHOOL.radiusMeters} metre olabilir.` });
      return;
    }
    if (accuracy > MAX_ACCURACY_METERS) {
      sendJson(res, 400, { error: `Konum hassasiyeti dusuk. Telefonunuz ${Math.round(accuracy)} metre hassasiyet bildiriyor; en fazla ${MAX_ACCURACY_METERS} metre olmali. Konum iznini acip tekrar deneyin.` });
      return;
    }
    const openEntry = await getOpenEntry(session.code);
    if (type === "in" && openEntry) {
      sendJson(res, 409, { error: "Zaten acik bir giris kaydiniz var." });
      return;
    }
    if (type === "checkin" && !openEntry) {
      sendJson(res, 409, { error: "Yoklama icin once giris yapmalisiniz." });
      return;
    }
    if ((type === "out" || type === "auto_out") && !openEntry) {
      sendJson(res, 409, { error: "Cikis icin once giris yapmalisiniz." });
      return;
    }

    const now = new Date();
    const hours = type === "out" || type === "auto_out" ? roundHours((now - new Date(openEntry.timestamp)) / 36e5) : "";
    await appendStudentEvent(student, {
      timestamp: now,
      type,
      position,
      distance,
      accuracy,
      deviceId,
      hours
    });
    sendJson(res, 201, { ok: true, type, hours, distance: Math.round(distance), checkin: await getCheckinStatus(session.code) });
    return;
  }

  sendJson(res, 404, { error: "API bulunamadi." });
}

function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  });
}

async function ensureWorkbook() {
  requireSheetsConfig();
  await ensureSheet("Students", [["code", "name", "passwordHash", "deviceId", "status", "createdAt", "note"]]);
  await ensureSheet("Events", [["timestamp", "code", "name", "type", "lat", "lng", "distanceMeters", "accuracyMeters", "deviceId", "hours"]]);
}

async function ensureStudentSheet(code, name) {
  const title = `Student_${code}`;
  const created = await ensureSheet(title, [["timestamp", "type", "lat", "lng", "distanceMeters", "accuracyMeters", "deviceId", "hours", "", "date", "totalHours"]]);
  if (created) {
    await sheetsUpdate(`${title}!J2:J2`, [[`=QUERY({ARRAYFORMULA(IF(A2:A="",,TO_DATE(INT(A2:A)))),H2:H},"select Col1, sum(Col2) where Col1 is not null group by Col1 label Col1 'date', sum(Col2) 'totalHours'",0)`]]);
    await sheetsUpdate(`${title}!M1:N2`, [["student", name], ["code", code]]);
  }
}

async function ensureSheet(title, seedRows) {
  const spreadsheet = await sheetsGet("");
  const exists = spreadsheet.sheets?.some((sheet) => sheet.properties?.title === title);
  if (!exists) {
    await sheetsBatchUpdate({
      requests: [{ addSheet: { properties: { title } } }]
    });
    if (seedRows?.length) {
      await sheetsAppend(`${title}!A1:Z`, seedRows);
    }
    return true;
  }
  return false;
}

async function getStudents() {
  const rows = await sheetsValues("Students!A:G");
  return rows.slice(1).map((row, index) => ({
    rowNumber: index + 2,
    code: row[0] || "",
    name: row[1] || "",
    passwordHash: row[2] || "",
    deviceId: row[3] || "",
    status: row[4] || "active"
  }));
}

async function findStudent(code) {
  const students = await getStudents();
  return students.find((student) => student.code === code);
}

async function updateStudentDevice(rowNumber, deviceId) {
  await sheetsUpdate(`Students!D${rowNumber}:D${rowNumber}`, [[deviceId]]);
}

async function getOpenEntry(code) {
  const rows = await sheetsValues("Events!A:J");
  const events = rowsToObjects(rows).filter((event) => event.code === code);
  return computeOpenEntry(events);
}

async function getEventsForCode(code) {
  const rows = await sheetsValues("Events!A:J");
  return rowsToObjects(rows).filter((event) => event.code === code);
}

function computeOpenEntry(events) {
  let openEntry = null;
  for (const event of events) {
    if (event.type === "in") openEntry = event;
    if (event.type === "out" || event.type === "auto_out") openEntry = null;
  }
  return openEntry;
}

async function auditMissedCheckins(student) {
  const events = await getEventsForCode(student.code);
  const openEntry = computeOpenEntry(events);
  if (!openEntry) return;
  const now = Date.now();
  const intervalMs = CHECKIN_INTERVAL_MINUTES * 60 * 1000;
  const graceMs = CHECKIN_GRACE_MINUTES * 60 * 1000;
  let lastCheckTime = getLastCheckinTime(events, openEntry);
  let missedCount = 0;

  while (lastCheckTime + intervalMs + graceMs <= now && missedCount < 24) {
    lastCheckTime += intervalMs;
    await appendStudentEvent(student, {
      timestamp: new Date(lastCheckTime),
      type: "missed_check",
      position: {},
      distance: "",
      accuracy: "",
      deviceId: "",
      hours: ""
    });
    missedCount += 1;
  }
}

async function auditAllMissedCheckins() {
  const students = await getStudents();
  for (const student of students.filter((item) => item.status === "active")) {
    await auditMissedCheckins(student);
  }
}

async function getCheckinStatus(code) {
  const events = await getEventsForCode(code);
  const openEntry = computeOpenEntry(events);
  if (!openEntry) return null;
  const lastCheckTime = getLastCheckinTime(events, openEntry);
  const nextDueAt = lastCheckTime + CHECKIN_INTERVAL_MINUTES * 60 * 1000;
  return {
    intervalMinutes: CHECKIN_INTERVAL_MINUTES,
    graceMinutes: CHECKIN_GRACE_MINUTES,
    lastAt: new Date(lastCheckTime).toISOString(),
    nextDueAt: new Date(nextDueAt).toISOString(),
    overdue: Date.now() > nextDueAt + CHECKIN_GRACE_MINUTES * 60 * 1000
  };
}

function getLastCheckinTime(events, openEntry) {
  const openTime = new Date(openEntry.timestamp).getTime();
  const last = events
    .filter((event) => new Date(event.timestamp).getTime() >= openTime)
    .filter((event) => ["in", "checkin", "missed_check"].includes(event.type))
    .at(-1);
  return new Date(last?.timestamp || openEntry.timestamp).getTime();
}

async function appendStudentEvent(student, event) {
  const timestamp = event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
  const position = event.position || {};
  const masterRow = [
    timestamp.toISOString(),
    student.code,
    student.name,
    event.type,
    position.lat ?? "",
    position.lng ?? "",
    event.distance === "" ? "" : Math.round(event.distance),
    event.accuracy === "" ? "" : Math.round(event.accuracy),
    event.deviceId || "",
    event.hours ?? ""
  ];
  await sheetsAppend("Events!A:J", [masterRow]);
  await ensureStudentSheet(student.code, student.name);
  await sheetsAppend(`Student_${student.code}!A:H`, [[
    timestamp.toISOString(),
    event.type,
    position.lat ?? "",
    position.lng ?? "",
    event.distance === "" ? "" : Math.round(event.distance),
    event.accuracy === "" ? "" : Math.round(event.accuracy),
    event.deviceId || "",
    event.hours ?? ""
  ]]);
}

function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ""])));
}

async function sheetsGet(pathname) {
  const token = await googleAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return parseGoogleResponse(response);
}

async function sheetsValues(range) {
  const token = await googleAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 400) return [];
  const data = await parseGoogleResponse(response);
  return data.values || [];
}

async function sheetsAppend(range, values) {
  const token = await googleAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values })
  });
  return parseGoogleResponse(response);
}

async function sheetsUpdate(range, values) {
  const token = await googleAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values })
  });
  return parseGoogleResponse(response);
}

async function sheetsBatchUpdate(body) {
  const token = await googleAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseGoogleResponse(response);
}

let cachedToken = null;
async function googleAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
  requireSheetsConfig();
  const now = Math.floor(Date.now() / 1000);
  const assertion = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify({
      iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600
    }))
  ].join(".");
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const signature = crypto.createSign("RSA-SHA256").update(assertion).sign(privateKey);
  const jwt = `${assertion}.${base64url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  const data = await parseGoogleResponse(response);
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function parseGoogleResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error?.message || data.error || `Google API hatasi: ${response.status}`);
  }
  return data;
}

function requireSheetsConfig() {
  if (!SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw Object.assign(new Error(".env icinde Google Sheets ayarlari eksik."), { statusCode: 400 });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Istek cok buyuk."));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function signToken(payload) {
  const body = base64url(JSON.stringify({ ...payload, exp: Date.now() + 1000 * 60 * 60 * 12 }));
  const sig = hmac(body);
  return `${body}.${sig}`;
}

function verifyToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || hmac(body) !== sig) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.exp < Date.now()) return null;
  return payload;
}

function requireAdmin(req) {
  const payload = verifyToken(bearer(req));
  if (!payload || payload.role !== "admin") throw Object.assign(new Error("Admin yetkisi gerekli."), { statusCode: 401 });
  return payload;
}

function requireStudent(req) {
  const payload = verifyToken(bearer(req));
  if (!payload || payload.role !== "student") throw Object.assign(new Error("Ogrenci oturumu gerekli."), { statusCode: 401 });
  return payload;
}

function bearer(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

function hmac(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 32).toString("base64url");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 32).toString("base64url");
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

function normalizePosition(position) {
  const lat = Number(position?.lat);
  const lng = Number(position?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw Object.assign(new Error("Konum bilgisi gecersiz."), { statusCode: 400 });
  }
  return { lat, lng, accuracy: Number(position?.accuracy || 9999) };
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const r = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(value) {
  return value * Math.PI / 180;
}

function roundHours(value) {
  return Math.round(value * 100) / 100;
}

function cleanCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
}

function cleanText(value) {
  return String(value || "").trim().slice(0, 200);
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}
