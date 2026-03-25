import {
  requestDevice,
  connectToDevice,
  disconnect,
  getCurrentAdb,
  pushFileStream,
  shell
} from "./adbService";

type QueueItemStatus = "queued" | "installing" | "success" | "failed";

interface BundleFileEntry {
  file: File;
  path: string;
}

interface BundleQueueDraft {
  displayName: string;
  packageName: string;
  apkFile: File;
  obbFiles: BundleFileEntry[];
}

interface BundleQueueItem extends BundleQueueDraft {
  id: string;
  status: QueueItemStatus;
  errorMessage?: string;
  detailMessage?: string;
}

interface InstallApkOptions {
  range?: { start: number; end: number };
  logLabel?: string;
  onStageChange?: (stage: string) => void;
}

const latestLogEl = document.getElementById("latestLog") as HTMLDivElement;
const progressPercentEl = document.getElementById("progressPercent") as HTMLSpanElement;
const progressFillEl = document.getElementById("progressFill") as HTMLDivElement;
const progressTrackEl = progressFillEl.parentElement as HTMLDivElement;
const apkInput = document.getElementById("apk") as HTMLInputElement;
const bundleInput = document.getElementById("bundle") as HTMLInputElement;
const apkPickEl = document.getElementById("apkPick") as HTMLDivElement;
const bundlePickEl = document.getElementById("bundlePick") as HTMLDivElement;
const apkLabelEl = document.getElementById("apkLabel") as HTMLElement;
const bundleLabelEl = document.getElementById("bundleLabel") as HTMLElement;
const bundleHintEl = document.getElementById("bundleHint") as HTMLSpanElement;
const bundleQueueEl = document.getElementById("bundleQueue") as HTMLDivElement;
const bundleQueueEmptyEl = document.getElementById("bundleQueueEmpty") as HTMLDivElement;
const installApkButton = document.getElementById("install") as HTMLButtonElement;
const installQueueButton = document.getElementById("installBundle") as HTMLButtonElement;
const addBundleButton = document.getElementById("addBundle") as HTMLButtonElement;
const clearBundleQueueButton = document.getElementById("clearBundleQueue") as HTMLButtonElement;
const stepSections = {
  1: document.getElementById("connectStepSection") as HTMLDivElement,
  2: document.getElementById("installStepSection") as HTMLDivElement,
  3: document.getElementById("installActionsSection") as HTMLDivElement
};

let activeStep = 1;
let stepTransitionTimeout: number | null = null;
let connected = false;
let installInProgress = false;
let bundleQueue: BundleQueueItem[] = [];
let nextQueueItemId = 1;

function browserSupportsWebUsb(): boolean {
  return typeof (navigator as any) !== "undefined" && "usb" in (navigator as any);
}

if (browserSupportsWebUsb()) {
  (navigator as any).usb.addEventListener("disconnect", async () => {
    log("⚠️ USB Disconnected.");
    await disconnect();
    connected = false;
    syncConnectionUi();
  });
}

function log(msg: string) {
  if (!latestLogEl.children.length && latestLogEl.textContent?.trim() === "Ready.") {
    latestLogEl.textContent = "";
  }

  const line = document.createElement("div");
  line.textContent = msg;
  latestLogEl.appendChild(line);
  latestLogEl.scrollTop = latestLogEl.scrollHeight;
}

function logErr(error: unknown) {
  console.error(error);
  log(`❌ ${error instanceof Error ? error.message : String(error)}`);
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
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

function hasInstallSelection() {
  return Boolean(apkInput.files?.length) || bundleQueue.length > 0;
}

function setVisibleStep(step: 1 | 2 | 3) {
  if (activeStep === step) return;
  const current = stepSections[activeStep as 1 | 2 | 3];
  const next = stepSections[step];
  if (!current || !next) {
    activeStep = step;
    return;
  }

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

function statusLabel(status: QueueItemStatus): string {
  switch (status) {
    case "installing":
      return "Installing";
    case "success":
      return "Success";
    case "failed":
      return "Failed";
    default:
      return "Queued";
  }
}

function defaultQueueDetail(item: BundleQueueItem): string {
  switch (item.status) {
    case "installing":
      return item.detailMessage || "Installing...";
    case "success":
      return item.detailMessage || "Installed successfully.";
    case "failed":
      return item.detailMessage || "Install failed.";
    default:
      return item.detailMessage || "Ready to install.";
  }
}

function renderQueue() {
  if (!bundleQueue.length) {
    bundleQueueEl.replaceChildren(bundleQueueEmptyEl);
    return;
  }

  const rows = bundleQueue.map((item) => {
    const row = document.createElement("div");
    row.className = "queue-item";

    const head = document.createElement("div");
    head.className = "queue-item__head";

    const titleWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "queue-item__title";
    title.textContent = item.displayName;

    const meta = document.createElement("div");
    meta.className = "queue-item__meta";
    meta.textContent = `${item.packageName} · ${item.apkFile.name} · ${item.obbFiles.length} ${pluralize(item.obbFiles.length, "OBB")}`;

    titleWrap.append(title, meta);

    const badge = document.createElement("div");
    badge.className = "status-badge";
    badge.textContent = statusLabel(item.status);

    head.append(titleWrap, badge);

    const detail = document.createElement("div");
    detail.className = "queue-item__detail";
    detail.textContent = defaultQueueDetail(item);

    const actions = document.createElement("div");
    actions.className = "queue-item__actions";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.disabled = installInProgress;
    removeButton.onclick = () => removeQueueItem(item.id);
    actions.appendChild(removeButton);

    row.append(head, detail);

    if (item.errorMessage) {
      const error = document.createElement("div");
      error.className = "queue-item__error";
      error.textContent = item.errorMessage;
      row.appendChild(error);
    }

    row.appendChild(actions);
    return row;
  });

  bundleQueueEl.replaceChildren(...rows);
}

function updatePickerLabels() {
  apkLabelEl.textContent = apkInput.files?.[0]?.name || "Select APK";

  if (!bundleQueue.length) {
    bundleLabelEl.textContent = "Add App Folder";
    bundleHintEl.textContent = "Queue folders with one APK + OBB package";
    return;
  }

  bundleLabelEl.textContent = `Queue: ${bundleQueue.length} ${pluralize(bundleQueue.length, "folder")}`;
  bundleHintEl.textContent = `${bundleQueue.length} ${pluralize(bundleQueue.length, "app")} ready for sequential install`;
}

function syncConnectionUi() {
  document.body.dataset.questConnected = connected ? "true" : "false";
  document.body.dataset.questBusy = installInProgress ? "true" : "false";

  const installStepEl = document.getElementById("installStepSection");
  const actionStepEl = document.getElementById("installActionsSection");
  const hasApk = Boolean(apkInput.files?.length);
  const hasQueue = bundleQueue.length > 0;
  const ready = connected && hasInstallSelection();

  if (installStepEl) installStepEl.classList.toggle("section--disabled", !connected);
  if (actionStepEl) actionStepEl.classList.toggle("section--disabled", !ready);

  installApkButton.disabled = !connected || !hasApk || installInProgress;
  installQueueButton.disabled = !connected || !hasQueue || installInProgress;
  addBundleButton.disabled = !connected || installInProgress;
  clearBundleQueueButton.disabled = installInProgress || !hasQueue;
  apkInput.disabled = !connected || installInProgress;
  bundleInput.disabled = !connected || installInProgress;
  apkPickEl.classList.toggle("picker--disabled", !connected || installInProgress);
  bundlePickEl.classList.toggle("picker--disabled", !connected || installInProgress);
  bundleQueueEl.setAttribute("aria-busy", String(installInProgress));

  updatePickerLabels();
  renderQueue();
  setVisibleStep(!connected ? 1 : ready ? 3 : 2);
}

function setInstallInProgress(next: boolean) {
  installInProgress = next;
  syncConnectionUi();
}

function updateQueueItem(id: string, updates: Partial<BundleQueueItem>) {
  const index = bundleQueue.findIndex((item) => item.id === id);
  if (index < 0) return;
  bundleQueue[index] = { ...bundleQueue[index], ...updates };
  renderQueue();
}

function removeQueueItem(id: string) {
  if (installInProgress) return;
  bundleQueue = bundleQueue.filter((item) => item.id !== id);
  syncConnectionUi();
}

function clearQueue() {
  if (installInProgress || !bundleQueue.length) return;
  bundleQueue = [];
  syncConnectionUi();
  log("Queue cleared.");
}

function createQueueItem(draft: BundleQueueDraft): BundleQueueItem {
  return {
    ...draft,
    id: `bundle-${Date.now()}-${nextQueueItemId++}`,
    status: "queued",
    detailMessage: "Ready to install."
  };
}

function stripSharedWrapperSegments(entries: BundleFileEntry[]) {
  let strippedEntries = entries.map((entry) => ({ ...entry }));
  const removedSegments: string[] = [];

  while (strippedEntries.length) {
    const splitEntries = strippedEntries.map((entry) => entry.path.split("/").filter(Boolean));
    if (splitEntries.some((parts) => parts.length < 2)) break;

    const commonSegment = splitEntries[0][0];
    if (!splitEntries.every((parts) => parts[0] === commonSegment)) break;

    removedSegments.push(commonSegment);
    strippedEntries = strippedEntries.map((entry) => ({
      ...entry,
      path: entry.path.split("/").slice(1).join("/")
    }));
  }

  return { entries: strippedEntries, removedSegments };
}

function tryParseBundle(entries: BundleFileEntry[], displayNameHint?: string) {
  if (!entries.length) {
    return { ok: false as const, error: "Folder is empty." };
  }

  const apkEntries = entries.filter((entry) => entry.path.toLowerCase().endsWith(".apk"));
  const rootApks = apkEntries.filter((entry) => !entry.path.includes("/"));
  if (apkEntries.length !== 1 || rootApks.length !== 1) {
    return { ok: false as const, error: "Expected exactly one APK at the folder root." };
  }

  const obbEntries = entries.filter((entry) => entry.path.toLowerCase().endsWith(".obb"));
  if (!obbEntries.length) {
    return { ok: false as const, error: "Expected at least one OBB file." };
  }

  if (obbEntries.some((entry) => entry.path.split("/").filter(Boolean).length !== 2)) {
    return { ok: false as const, error: "OBB files must sit directly inside one package folder." };
  }

  const packageNames = Array.from(new Set(obbEntries.map((entry) => entry.path.split("/")[0])));
  if (packageNames.length !== 1) {
    return { ok: false as const, error: "OBB files must all live inside one package folder." };
  }

  const packageName = packageNames[0];
  const displayName = displayNameHint || packageName || basename(rootApks[0].file.name);

  return {
    ok: true as const,
    item: {
      displayName,
      packageName,
      apkFile: rootApks[0].file,
      obbFiles: obbEntries
    }
  };
}

function parseBundleSelection(files: FileList) {
  const normalizedEntries = Array.from(files)
    .map((file) => ({
      file,
      path: normalizePath(file.webkitRelativePath || file.name)
    }))
    .filter((entry) => Boolean(entry.path));

  if (!normalizedEntries.length) {
    return { items: [] as BundleQueueDraft[], errors: ["No files were selected."] };
  }

  const normalizedRoot = stripSharedWrapperSegments(normalizedEntries);
  const lastRemovedRoot = normalizedRoot.removedSegments[normalizedRoot.removedSegments.length - 1];
  const singleBundle = tryParseBundle(normalizedRoot.entries, lastRemovedRoot);
  if (singleBundle.ok) {
    return { items: [singleBundle.item], errors: [] as string[] };
  }

  const groupedEntries = new Map<string, BundleFileEntry[]>();
  let hasRootInstallFiles = false;

  for (const entry of normalizedRoot.entries) {
    const parts = entry.path.split("/").filter(Boolean);
    if (parts.length < 2) {
      if (entry.path.toLowerCase().endsWith(".apk") || entry.path.toLowerCase().endsWith(".obb")) {
        hasRootInstallFiles = true;
      }
      continue;
    }

    const [groupName, ...rest] = parts;
    const groupEntries = groupedEntries.get(groupName) || [];
    groupEntries.push({ file: entry.file, path: rest.join("/") });
    groupedEntries.set(groupName, groupEntries);
  }

  if (!groupedEntries.size) {
    return { items: [] as BundleQueueDraft[], errors: [singleBundle.error] };
  }

  if (hasRootInstallFiles) {
    return {
      items: [] as BundleQueueDraft[],
      errors: ["Selection mixes root install files with nested app folders. Choose each app folder directly."]
    };
  }

  const items: BundleQueueDraft[] = [];
  const errors: string[] = [];

  for (const [groupName, groupEntries] of groupedEntries) {
    const normalizedGroup = stripSharedWrapperSegments(groupEntries);
    const lastRemovedGroup = normalizedGroup.removedSegments[normalizedGroup.removedSegments.length - 1];
    const parsedGroup = tryParseBundle(normalizedGroup.entries, lastRemovedGroup || groupName);

    if (parsedGroup.ok) {
      items.push(parsedGroup.item);
    } else {
      errors.push(`${lastRemovedGroup || groupName}: ${parsedGroup.error}`);
    }
  }

  if (!items.length && !errors.length) {
    errors.push(singleBundle.error);
  }

  return { items, errors };
}

function addBundleToQueue(draft: BundleQueueDraft) {
  bundleQueue.push(createQueueItem(draft));
}

function addSelectedBundles(files: FileList | null) {
  if (!files?.length) return;

  const { items, errors } = parseBundleSelection(files);
  for (const error of errors) {
    log(`❌ ${error}`);
  }

  for (const item of items) {
    addBundleToQueue(item);
    log(`Queued ${item.displayName} (${item.apkFile.name}, ${item.obbFiles.length} ${pluralize(item.obbFiles.length, "OBB")}).`);
  }

  if (!items.length) {
    log("No valid app folders were added to the queue.");
  }

  syncConnectionUi();
}

function resetQueueStatuses() {
  bundleQueue = bundleQueue.map((item) => ({
    ...item,
    status: "queued",
    errorMessage: undefined,
    detailMessage: "Ready to install."
  }));
  renderQueue();
}

async function installApkFile(apkFile: File, options: InstallApkOptions = {}) {
  if (!connected || !getCurrentAdb()) throw new Error("No device connected.");

  const range = options.range ?? { start: 0, end: 100 };
  const pushProgress = mapProgressRange(range.start + 5, range.start + 75);
  const totalProgress = mapProgressRange(range.start, range.end);
  const remoteApk = `/data/local/tmp/${Date.now()}_${sanitize(apkFile.name)}`;
  const label = options.logLabel ?? apkFile.name;

  try {
    options.onStageChange?.("Uploading APK");
    log(`Pushing APK: ${label}`);
    await pushFileStream(remoteApk, apkFile, (sent, total) => pushProgress(total > 0 ? sent / total : 1));

    options.onStageChange?.("Installing APK");
    log(`Installing APK: ${label}`);
    const output = (await shell(["pm", "install", "-r", remoteApk])).trim();
    const success = output.toLowerCase().includes("success");

    log(success ? `✅ ${label} installed.` : `⚠️ ${label}: ${output || "Install failed."}`);
    return { success, output };
  } finally {
    try {
      await shell(["rm", "-f", remoteApk]);
    } catch (error) {
      console.warn(error);
    }
    totalProgress(1);
  }
}

async function installBundleItem(item: BundleQueueItem, index: number, totalItems: number) {
  const itemStart = (index / totalItems) * 100;
  const itemEnd = ((index + 1) / totalItems) * 100;
  const itemProgress = mapProgressRange(itemStart, itemEnd);

  const apkResult = await installApkFile(item.apkFile, {
    range: { start: itemStart, end: itemStart + (itemEnd - itemStart) * 0.55 },
    logLabel: `${item.displayName} / ${item.apkFile.name}`,
    onStageChange: (stage) => updateQueueItem(item.id, { detailMessage: stage })
  });

  if (!apkResult.success) {
    throw new Error(apkResult.output || "APK install failed.");
  }

  updateQueueItem(item.id, { detailMessage: "Preparing OBB directory" });
  log(`Preparing OBB directory: ${item.packageName}`);

  const remoteDir = `/sdcard/Android/obb/${item.packageName}`;
  await shell(["rm", "-rf", remoteDir]);
  await shell(["mkdir", "-p", remoteDir]);
  itemProgress(0.65);

  for (let obbIndex = 0; obbIndex < item.obbFiles.length; obbIndex += 1) {
    const obb = item.obbFiles[obbIndex];
    const versionCode = Math.floor(obb.file.size / 1024);
    const obbName = `main.${versionCode}.${item.packageName}.obb`;
    const remotePath = `${remoteDir}/${obbName}`;
    const obbStart = 0.65 + (obbIndex / item.obbFiles.length) * 0.35;
    const obbEnd = 0.65 + ((obbIndex + 1) / item.obbFiles.length) * 0.35;

    updateQueueItem(item.id, { detailMessage: `Pushing OBB ${obbIndex + 1}/${item.obbFiles.length}` });
    log(`Pushing OBB (${obbIndex + 1}/${item.obbFiles.length}): ${basename(obb.path)} for ${item.displayName}`);

    await pushFileStream(remotePath, obb.file, (sent, total) => {
      const fraction = total > 0 ? sent / total : 1;
      itemProgress(obbStart + (obbEnd - obbStart) * fraction);
    });
    await shell(["chmod", "644", remotePath]);
    log(`✅ Pushed OBB to ${remotePath}`);
  }

  itemProgress(1);
}

function canContinueQueue() {
  return connected && Boolean(getCurrentAdb());
}

async function installBundleQueue() {
  if (!bundleQueue.length || installInProgress) return;

  resetQueueStatuses();
  setInstallInProgress(true);
  setProgress(0);
  log(`Starting bundle queue with ${bundleQueue.length} ${pluralize(bundleQueue.length, "folder")}.`);

  let successCount = 0;
  let failedCount = 0;
  let stoppedEarly = false;

  try {
    for (let index = 0; index < bundleQueue.length; index += 1) {
      const item = bundleQueue[index];
      updateQueueItem(item.id, {
        status: "installing",
        errorMessage: undefined,
        detailMessage: `Starting ${index + 1}/${bundleQueue.length}`
      });

      log(`▶️ [${index + 1}/${bundleQueue.length}] ${item.displayName} (${item.packageName})`);

      try {
        await installBundleItem(item, index, bundleQueue.length);
        successCount += 1;
        updateQueueItem(item.id, {
          status: "success",
          detailMessage: `${item.obbFiles.length} ${pluralize(item.obbFiles.length, "OBB")} pushed.`
        });
        log(`✅ Finished ${item.displayName}.`);
      } catch (error) {
        failedCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        updateQueueItem(item.id, {
          status: "failed",
          errorMessage: message,
          detailMessage: "Install failed."
        });
        log(`❌ ${item.displayName} failed: ${message}`);

        if (!canContinueQueue()) {
          stoppedEarly = true;
          break;
        }
      }
    }
  } finally {
    setInstallInProgress(false);
  }

  const attemptedCount = successCount + failedCount;
  const skippedCount = bundleQueue.length - attemptedCount;
  if (attemptedCount === bundleQueue.length) {
    setProgress(100);
  } else {
    setProgress((attemptedCount / bundleQueue.length) * 100);
  }

  if (stoppedEarly && skippedCount > 0) {
    log(`⚠️ Queue stopped early. ${skippedCount} ${pluralize(skippedCount, "item")} were not attempted.`);
  }

  log(`Queue complete. ${successCount} succeeded, ${failedCount} failed${skippedCount ? `, ${skippedCount} skipped` : ""}.`);
}

apkInput.addEventListener("change", syncConnectionUi);

bundleInput.addEventListener("change", () => {
  addSelectedBundles(bundleInput.files);
  bundleInput.value = "";
});

clearBundleQueueButton.addEventListener("click", clearQueue);

(document.getElementById("connect") as HTMLButtonElement).onclick = async () => {
  try {
    latestLogEl.innerHTML = "";
    const device = await requestDevice();
    if (!device) return;

    await connectToDevice(device, () => log("Auth pending..."));
    connected = true;
    syncConnectionUi();

    const model = (await shell(["getprop", "ro.product.model"])).trim();
    log(`✅ Connected: ${model}`);
  } catch (error) {
    logErr(error);
  }
};

(document.getElementById("disconnect") as HTMLButtonElement).onclick = async () => {
  await disconnect();
  connected = false;
  syncConnectionUi();
  log("Disconnected.");
};

installApkButton.onclick = async () => {
  const apk = apkInput.files?.[0];
  if (!apk || installInProgress) return;

  setInstallInProgress(true);
  setProgress(0);

  try {
    const result = await installApkFile(apk);
    if (result.success) {
      log("✨ APK Completed. You can safely detach your Quest.");
    }
  } catch (error) {
    logErr(error);
  } finally {
    setInstallInProgress(false);
  }
};

installQueueButton.onclick = async () => {
  try {
    await installBundleQueue();
  } catch (error) {
    logErr(error);
  }
};

syncConnectionUi();
