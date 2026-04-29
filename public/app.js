const state = {
  school: null,
  studentToken: localStorage.getItem("studentToken") || "",
  adminToken: localStorage.getItem("adminToken") || "",
  deviceId: getDeviceId(),
  currentPosition: null
};

const $ = (selector) => document.querySelector(selector);

const authPanel = $("#authPanel");
const studentPanel = $("#studentPanel");
const adminPanel = $("#adminPanel");
const toast = $("#toast");

init();

async function init() {
  bindUi();
  await loadConfig();
  watchPosition();
  if (state.studentToken) await loadStudent();
  if (state.adminToken) await loadAdmin();
}

function bindUi() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      $("#studentLogin").classList.toggle("hidden", tab.dataset.tab !== "student");
      $("#adminLogin").classList.toggle("hidden", tab.dataset.tab !== "admin");
    });
  });

  $("#studentLogin").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api("/api/student/login", {
      method: "POST",
      body: { ...data, deviceId: state.deviceId }
    });
    state.studentToken = result.token;
    localStorage.setItem("studentToken", result.token);
    showToast("Giris basarili.");
    await loadStudent();
  });

  $("#adminLogin").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api("/api/admin/login", { method: "POST", body: data });
    state.adminToken = result.token;
    localStorage.setItem("adminToken", result.token);
    showToast("Admin girisi basarili.");
    await loadAdmin();
  });

  $("#addStudent").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    await api("/api/admin/students", { method: "POST", body: data, token: state.adminToken });
    event.currentTarget.reset();
    showToast("Ogrenci eklendi.");
    await loadAdmin();
  });

  $("#checkIn").addEventListener("click", () => sendEvent("in"));
  $("#checkOut").addEventListener("click", () => sendEvent("out"));
  $("#studentLogout").addEventListener("click", logoutStudent);
  $("#adminLogout").addEventListener("click", logoutAdmin);
}

async function loadConfig() {
  const config = await api("/api/config");
  state.school = config.school;
  $("#configText").textContent = config.sheetsReady
    ? `Okula ${config.school.radiusMeters} metre icinde giris/cikis yapilabilir.`
    : "Google Sheets ayarlari eksik. .env dosyasini doldurun.";
}

async function loadStudent() {
  try {
    const data = await api("/api/student/me", { token: state.studentToken });
    authPanel.classList.add("hidden");
    adminPanel.classList.add("hidden");
    studentPanel.classList.remove("hidden");
    $("#studentName").textContent = `${data.name} (${data.code})`;
    $("#entryStatus").textContent = data.openEntry ? "Iceride" : "Disarida";
    renderStudentRows(data.rows);
  } catch (error) {
    logoutStudent(false);
    showToast(error.message);
  }
}

async function loadAdmin() {
  try {
    const data = await api("/api/admin/events", { token: state.adminToken });
    authPanel.classList.add("hidden");
    studentPanel.classList.add("hidden");
    adminPanel.classList.remove("hidden");
    renderAdminRows(data.events);
  } catch (error) {
    logoutAdmin(false);
    showToast(error.message);
  }
}

async function sendEvent(type) {
  if (!state.currentPosition) {
    showToast("Konum alinamadi. Tarayicida konum izni verin.");
    return;
  }
  const result = await api("/api/student/event", {
    method: "POST",
    token: state.studentToken,
    body: {
      type,
      deviceId: state.deviceId,
      position: state.currentPosition
    }
  });
  showToast(type === "in" ? "Giris kaydedildi." : `Cikis kaydedildi. Sure: ${result.hours} saat.`);
  await loadStudent();
}

function watchPosition() {
  if (!navigator.geolocation) {
    $("#distanceStatus").textContent = "Konum desteklenmiyor";
    return;
  }
  navigator.geolocation.watchPosition((position) => {
    state.currentPosition = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy
    };
    if (state.school) {
      const distance = distanceMeters(state.currentPosition.lat, state.currentPosition.lng, state.school.lat, state.school.lng);
      $("#distanceStatus").textContent = `${Math.round(distance)} m`;
    }
  }, () => {
    $("#distanceStatus").textContent = "Konum izni yok";
  }, {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 15000
  });
}

function renderStudentRows(rows) {
  $("#studentRows").innerHTML = rows.map((row) => `
    <tr>
      <td>${formatDate(row.timestamp)}</td>
      <td>${row.type === "in" ? "Giris" : "Cikis"}</td>
      <td>${row.distanceMeters || "-"} m</td>
      <td>${row.hours || "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="4">Kayit yok</td></tr>`;
}

function renderAdminRows(rows) {
  $("#adminRows").innerHTML = rows.map((row) => `
    <tr>
      <td>${formatDate(row.timestamp)}</td>
      <td>${row.name || row.code}</td>
      <td>${row.type === "in" ? "Giris" : "Cikis"}</td>
      <td>${row.distanceMeters || "-"} m</td>
      <td>${row.hours || "-"}</td>
    </tr>
  `).join("") || `<tr><td colspan="5">Kayit yok</td></tr>`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Istek basarisiz.");
  return data;
}

function logoutStudent(show = true) {
  state.studentToken = "";
  localStorage.removeItem("studentToken");
  studentPanel.classList.add("hidden");
  authPanel.classList.remove("hidden");
  if (show) showToast("Oturum kapatildi.");
}

function logoutAdmin(show = true) {
  state.adminToken = "";
  localStorage.removeItem("adminToken");
  adminPanel.classList.add("hidden");
  authPanel.classList.remove("hidden");
  if (show) showToast("Oturum kapatildi.");
}

function getDeviceId() {
  const existing = localStorage.getItem("deviceId");
  if (existing) return existing;
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem("deviceId", id);
  return id;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
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
