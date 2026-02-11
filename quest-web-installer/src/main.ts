import {
  requestDevice,
  connectToDevice,
  disconnect,
  getCurrentAdb,
  pushFileStream,
  shell
} from "./adbService";

const latestLogEl = document.getElementById("latestLog") as HTMLDivElement;
const progressPercentEl = document.getElementById("progressPercent") as HTMLSpanElement;
const progressFillEl = document.getElementById("progressFill") as HTMLDivElement;
const progressTrackEl = progressFillEl.parentElement as HTMLDivElement;
const apkInput = document.getElementById("apk") as HTMLInputElement;
const bundleInput = document.getElementById("bundle") as HTMLInputElement;

function browserSupportsWebUsb(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

function showWebUsbUnsupportedModal() {
  const blocker = document.createElement("div");
  blocker.id = "webusb-blocker";
  blocker.setAttribute("role", "dialog");
  blocker.setAttribute("aria-modal", "true");
  blocker.setAttribute("aria-labelledby", "webusb-blocker-title");

  blocker.innerHTML = `
    <div id="webusb-blocker-card">
      <h2 id="webusb-blocker-title">Browser not supported</h2>
      <p>
        This installer requires <strong>WebUSB</strong>, which is not available in your current browser.
      </p>
      <p>
        Please open this page in a Chromium-based browser (for example, Chrome, Edge, or Opera) on a computer (Windows, Mac, Linux)
        and try again.
      </p>
    </div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    #webusb-blocker {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(8px);
    }

    #webusb-blocker-card {
      width: min(560px, 100%);
      border: 1px solid #fff;
      background: #050505;
      color: #fff;
      padding: 24px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
    }

    #webusb-blocker-card h2 {
      margin: 0 0 12px;
      font-size: 24px;
      letter-spacing: 0.02em;
    }

    #webusb-blocker-card p {
      margin: 0;
      color: rgba(255, 255, 255, 0.9);
      line-height: 1.5;
    }

    #webusb-blocker-card p + p {
      margin-top: 12px;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(blocker);

  const controls = Array.from(document.querySelectorAll("button, input, [role='button']")) as HTMLElement[];
  for (const control of controls) {
    control.setAttribute("aria-disabled", "true");
    if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) {
      control.disabled = true;
    }
  }
}

if (!browserSupportsWebUsb()) {
  showWebUsbUnsupportedModal();
  throw new Error("WebUSB is not supported in this browser.");
}

function log(msg: string) {
  console.log(msg);
  latestLogEl.textContent = msg;
}
function logErr(e: any) {
  console.error(e);
  log(`❌ ${e?.message ?? String(e)}`);
}

let connected = false;

function syncConnectionUi() {
  document.body.dataset.questConnected = connected ? "true" : "false";

  const installStepSection = document.getElementById("installStepSection");
  if (!installStepSection) return;

  installStepSection.classList.toggle("section--disabled", !connected);
}

syncConnectionUi();

function ensureConnected() {
  if (!connected || !getCurrentAdb()) throw new Error("No device connected. Click Connect first.");
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function normManifestPath(p: string): string {
  return p.trim().replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function stripTopFolder(rel: string): string {
  const idx = rel.indexOf("/");
  return idx >= 0 ? rel.slice(idx + 1) : rel;
}

function makePercentLogger(prefix: string) {
  let last = -1;
  return (sent: number, total: number, onProgress?: (fraction: number) => void) => {
    if (total <= 0) return;
    const fraction = Math.min(Math.max(sent / total, 0), 1);
    onProgress?.(fraction);
    const pct = Math.floor(fraction * 100);
    if (pct >= 100 || pct >= last + 5) {
      last = pct;
      log(`${prefix}: ${pct}%`);
    }
  };
}

function setProgress(pct: number) {
  const clamped = Math.min(100, Math.max(0, Math.round(pct)));
  progressFillEl.style.width = `${clamped}%`;
  progressPercentEl.textContent = `${clamped}%`;
  progressTrackEl.setAttribute("aria-valuenow", String(clamped));
}

function mapProgressRange(start: number, end: number) {
  const span = end - start;
  return (fraction: number) => setProgress(start + span * fraction);
}

(document.getElementById("connect") as HTMLButtonElement).onclick = async () => {
  try {
    log("Connect clicked.");

    const dev = await requestDevice();
    if (!dev) {
      log("User cancelled device picker.");
      return;
    }

    log(`USB device selected. Serial: ${dev.serial}`);
    log("Connecting to ADB… (put headset on and accept USB debugging)");

    await connectToDevice(dev, () => {
      log("Auth pending: accept the prompt inside the headset.");
    });

    connected = true;
    syncConnectionUi();

    const model = (await shell(["getprop", "ro.product.model"])).trim();
    const manufacturer = (await shell(["getprop", "ro.product.manufacturer"])).trim();
    log(`✅ Connected to ${manufacturer || "Unknown"} ${model || ""}`);
  } catch (e) {
    logErr(e);
  }
};

(document.getElementById("disconnect") as HTMLButtonElement).onclick = async () => {
  try {
    await disconnect();
    connected = false;
    syncConnectionUi();
    log("Disconnected.");
  } catch (e) {
    logErr(e);
  }
};

async function installApkFile(apkFile: File, progressRange: { start: number; end: number } = { start: 0, end: 100 }) {
  ensureConnected();
  const pushProgress = mapProgressRange(progressRange.start + 10, progressRange.start + 70);
  const setLocalProgress = mapProgressRange(progressRange.start, progressRange.end);

  setLocalProgress(0);

  log(`APK: ${apkFile.name} (${apkFile.size} bytes)`);

  const remoteApk = `/data/local/tmp/${Date.now()}_${sanitize(apkFile.name)}`;
  log(`Pushing APK → ${remoteApk}`);
  setLocalProgress(0.1);

  const apkPushLogger = makePercentLogger("APK push");
  await pushFileStream(remoteApk, apkFile, (sent, total) => apkPushLogger(sent, total, pushProgress));

  log("Installing APK (pm install -r) …");
  setLocalProgress(0.85);
  const out = await shell(["pm", "install", "-r", remoteApk]);
  log(`pm output: ${out.trim() || "(no output)"}`);

  log("Cleaning temp APK…");
  setLocalProgress(0.95);
  await shell(["rm", "-f", remoteApk]);

  if (out.toLowerCase().includes("success")) {
    log("✅ APK install success. Quest → Apps → Unknown Sources.");
  } else {
    log("⚠️ APK install may have failed (see pm output above).");
  }

  setLocalProgress(1);
}

(document.getElementById("install") as HTMLButtonElement).onclick = async () => {
  try {
    const apk = apkInput.files?.[0];
    if (!apk) throw new Error("Pick an APK first.");
    await installApkFile(apk);
  } catch (e) {
    logErr(e);
  }
};

type ManifestInfo = {
  packageName: string;
  versionCode: string;
  apkPath: string;
  obbPaths: string[];
};

function parseReleaseManifest(text: string): ManifestInfo {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const headerIdx = lines.findIndex(l => l.includes("Package Name") && l.includes("Version Code") && l.includes(";"));
  if (headerIdx < 0 || headerIdx + 1 >= lines.length) throw new Error("Manifest missing metadata header/row.");

  const header = lines[headerIdx].split(";");
  const row = lines[headerIdx + 1].split(";");

  const pkgCol = header.findIndex(h => h.trim() === "Package Name");
  const verCol = header.findIndex(h => h.trim() === "Version Code");
  if (pkgCol < 0 || verCol < 0) throw new Error("Manifest missing Package Name / Version Code columns.");

  const packageName = (row[pkgCol] || "").trim();
  const versionCode = (row[verCol] || "").trim();
  if (!packageName || !versionCode) throw new Error("Manifest has empty packageName/versionCode.");

  const filelistIdx = lines.findIndex(l => l.toLowerCase() === "#filelist");
  if (filelistIdx < 0) throw new Error("Manifest missing #filelist section.");

  const apkPaths: string[] = [];
  const obbPaths: string[] = [];

  for (let i = filelistIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.includes(";")) continue;
    const parts = l.split(";");
    if (parts.length < 3) continue;
    const type = parts[0];
    const name = parts[1];
    if (type !== "f") continue;

    const p = normManifestPath(name);
    if (p.toLowerCase().endsWith(".apk")) apkPaths.push(p);
    if (p.toLowerCase().endsWith(".obb")) obbPaths.push(p);
  }

  if (!apkPaths.length) throw new Error("Manifest filelist contains no APK.");
  if (!obbPaths.length) throw new Error("Manifest filelist contains no OBB.");

  const apkPath = apkPaths[0];

  return { packageName, versionCode, apkPath, obbPaths };
}

function buildBundleFileMap(files: FileList): Map<string, File> {
  const map = new Map<string, File>();

  for (const f of Array.from(files)) {
    const rel = (f as any).webkitRelativePath ? String((f as any).webkitRelativePath) : f.name;
    const stripped = stripTopFolder(rel);
    map.set(stripped, f);
  }

  return map;
}

function findFileByPathOrSuffix(map: Map<string, File>, manifestPath: string): File | null {
  const direct = map.get(manifestPath);
  if (direct) return direct;

  const want = manifestPath.replace(/\\/g, "/");
  for (const [k, v] of map.entries()) {
    const kk = k.replace(/\\/g, "/");
    if (kk.endsWith(want)) return v;
  }
  return null;
}

async function installBundle(files: FileList) {
  ensureConnected();
  setProgress(0);

  const map = buildBundleFileMap(files);

  const manifestFile =
    map.get("release.manifest")
    || Array.from(map.entries()).find(([k]) => k.endsWith("/release.manifest") || k.endsWith("release.manifest"))?.[1];

  if (!manifestFile) throw new Error("Bundle folder missing release.manifest");

  log(`Reading manifest: ${manifestFile.name}`);
  setProgress(5);
  const manifestText = await manifestFile.text();
  const info = parseReleaseManifest(manifestText);
  setProgress(10);

  log(`Bundle package: ${info.packageName}`);
  log(`Bundle versionCode: ${info.versionCode}`);
  log(`Manifest APK path: ${info.apkPath}`);
  log(`Manifest OBB files: ${info.obbPaths.length}`);

  const apkFile = findFileByPathOrSuffix(map, info.apkPath);
  if (!apkFile) throw new Error(`Could not locate APK file from manifest: ${info.apkPath}`);

  const obbFiles: { path: string; file: File }[] = [];
  for (const obbPathRaw of info.obbPaths) {
    const obbFile = findFileByPathOrSuffix(map, obbPathRaw);
    if (!obbFile) throw new Error(`Could not locate OBB from manifest: ${obbPathRaw}`);
    obbFiles.push({ path: obbPathRaw, file: obbFile });
  }

  log("---- Installing APK ----");
  await installApkFile(apkFile, { start: 10, end: 60 });

  log("---- Installing OBB ----");
  const obbDir = `/sdcard/Android/obb/${info.packageName}`;
  log(`Ensuring OBB dir: ${obbDir}`);
  setProgress(65);
  await shell(["mkdir", "-p", obbDir]);

  let obbBytesDone = 0;
  const totalObbBytes = obbFiles.reduce((sum, obb) => sum + obb.file.size, 0);
  const obbRange = mapProgressRange(70, 98);

  for (const { path, file } of obbFiles) {
    const fileName = basename(path);
    const remoteObb = `${obbDir}/${fileName}`;
    log(`Pushing OBB → ${remoteObb} (${file.size} bytes)`);

    const obbPushLogger = makePercentLogger(`OBB ${fileName}`);
    await pushFileStream(remoteObb, file, (sent, total) => {
      obbPushLogger(sent, total);
      if (totalObbBytes > 0) {
        const overallFraction = Math.min((obbBytesDone + sent) / totalObbBytes, 1);
        obbRange(overallFraction);
      }
    });
    obbBytesDone += file.size;
  }

  log("✅ Bundle install completed. Launch the game from Unknown Sources.");
  setProgress(100);
}

(document.getElementById("installBundle") as HTMLButtonElement).onclick = async () => {
  try {
    const files = bundleInput.files;
    if (!files || files.length === 0) throw new Error("Pick a bundle folder first.");
    await installBundle(files);
  } catch (e) {
    logErr(e);
  }
};
