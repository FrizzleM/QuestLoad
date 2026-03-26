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
const stepSections = {
  1: document.getElementById("connectStepSection") as HTMLDivElement,
  2: document.getElementById("installStepSection") as HTMLDivElement,
  3: document.getElementById("installActionsSection") as HTMLDivElement
};

let activeStep = 1;
let stepTransitionTimeout: number | null = null;
let connected = false;

function browserSupportsWebUsb(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

if (browserSupportsWebUsb()) {
  navigator.usb.addEventListener("disconnect", async () => {
    log("⚠️ USB Disconnected.");
    await disconnect();
    connected = false;
    syncConnectionUi();
  });
}

function log(msg: string) {
  const line = document.createElement("div");
  line.textContent = msg;
  latestLogEl.appendChild(line);
  latestLogEl.scrollTop = latestLogEl.scrollHeight;
}

function logErr(e: any) {
  console.error(e);
  log(`❌ ${e?.message ?? String(e)}`);
}

function hasInstallSelection() {
  return Boolean(apkInput.files?.length) || Boolean(bundleInput.files?.length);
}

function syncConnectionUi() {
  document.body.dataset.questConnected = connected ? "true" : "false";
  const s2 = document.getElementById("installStepSection");
  const s3 = document.getElementById("installActionsSection");
  const b1 = document.getElementById("install") as HTMLButtonElement;
  const b2 = document.getElementById("installBundle") as HTMLButtonElement;

  if (s2) s2.classList.toggle("section--disabled", !connected);
  const ready = connected && hasInstallSelection();
  if (s3) s3.classList.toggle("section--disabled", !ready);
  if (b1) b1.disabled = !ready;
  if (b2) b2.disabled = !ready;

  setVisibleStep(!connected ? 1 : ready ? 3 : 2);
}

function setVisibleStep(step: 1 | 2 | 3) {
  if (activeStep === step) return;
  const current = stepSections[activeStep as 1 | 2 | 3];
  const next = stepSections[step];
  if (!current || !next) { activeStep = step; return; }

  if (stepTransitionTimeout) window.clearTimeout(stepTransitionTimeout);
  current.classList.add("is-leaving");

  stepTransitionTimeout = window.setTimeout(() => {
    current.classList.remove("is-leaving");
    current.classList.add("is-hidden");
    next.classList.remove("is-hidden");
    next.classList.add("is-entering");
    window.setTimeout(() => next.classList.remove("is-entering"), 240);
    activeStep = step;
  }, 220);
}

apkInput.addEventListener("change", syncConnectionUi);
bundleInput.addEventListener("change", syncConnectionUi);
syncConnectionUi();

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function stripTopFolder(rel: string): string {
  const idx = rel.indexOf("/");
  return idx >= 0 ? rel.slice(idx + 1) : rel;
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
    latestLogEl.innerHTML = "";
    const dev = await requestDevice();
    if (!dev) return;
    await connectToDevice(dev, () => log("Auth pending..."));
    connected = true;
    syncConnectionUi();
    const model = (await shell(["getprop", "ro.product.model"])).trim();
    log(`✅ Connected: ${model}`);
  } catch (e) { logErr(e); }
};

(document.getElementById("disconnect") as HTMLButtonElement).onclick = async () => {
  await disconnect();
  connected = false;
  syncConnectionUi();
  log("Disconnected.");
};

async function installApkFile(apkFile: File, range = { start: 0, end: 100 }) {
  if (!connected) return;
  const pushProgress = mapProgressRange(range.start + 5, range.start + 75);
  const totalProgress = mapProgressRange(range.start, range.end);
  const remoteApk = `/data/local/tmp/${Date.now()}_${sanitize(apkFile.name)}`;

  try {
    log(`Pushing ${apkFile.name}...`);
    await pushFileStream(remoteApk, apkFile, (s, t) => pushProgress(s / t));
    log("Installing...");
    const out = await shell(["pm", "install", "-r", remoteApk]);
    log(out.toLowerCase().includes("success") ? "✅ Success" : `⚠️ ${out}`);
  } finally {
    await shell(["rm", "-f", remoteApk]);
    totalProgress(1);
  }
}

(document.getElementById("install") as HTMLButtonElement).onclick = async () => {
  const apk = apkInput.files?.[0];
  if (apk) await installApkFile(apk);
};

function resolveBundle(files: FileList) {
  const entries = Array.from(files).map(f => ({
    file: f,
    path: stripTopFolder(f.webkitRelativePath || f.name).replace(/\\/g, "/")
  }));
  const apk = entries.find(e => e.path.endsWith(".apk") && !e.path.includes("/"));
  const obbs = entries.filter(e => e.path.endsWith(".obb") && e.path.includes("/"));

  if (!apk || !obbs.length) throw new Error("Invalid bundle layout.");
  const pkg = obbs[0].path.split("/")[0];
  return { packageName: pkg, apkFile: apk.file, obbFiles: obbs };
}

(document.getElementById("installBundle") as HTMLButtonElement).onclick = async () => {
  try {
    const bundle = resolveBundle(bundleInput.files!);
    await installApkFile(bundle.apkFile, { start: 0, end: 50 });
    
    const remoteDir = `/sdcard/Android/obb/${bundle.packageName}`;
    await shell(["rm", "-rf", remoteDir]);
    await shell(["mkdir", "-p", remoteDir]);

    for (const obb of bundle.obbFiles) {
      const remotePath = `${remoteDir}/${basename(obb.path)}`;
      log(`Pushing OBB: ${basename(obb.path)}`);
      await pushFileStream(remotePath, obb.file);
    }
    setProgress(100);
    log("✨ Bundle Completed. You can safely detach your Quest.");
  } catch (e) { logErr(e); }
};