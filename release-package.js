"use strict";
// Versioned, data-only release format. Receivers never execute a remote file
// list or write into the live source/configuration directory.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const FORMAT = 1,
  MAX_BYTES = 64 * 1024 * 1024,
  CHUNK_BYTES = 48 * 1024;
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");
const store = (root) => path.join(root, ".swt");
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function safeName(name) {
  return (
    typeof name === "string" &&
    name.length < 240 &&
    name
      .split("/")
      .every(
        (p) =>
          /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(p) &&
          !["node_modules", "runtime", "backups", "releases"].includes(p),
      ) &&
    !/^(?:config(?:[.-].*)?\.json|auth\.json|release-manifest\.json)$/.test(
      name,
    )
  );
}
function manifestId(manifest) {
  const { id, ...body } = manifest;
  return digest(JSON.stringify(body));
}
function validateManifest(manifest) {
  if (
    !manifest ||
    manifest.format !== FORMAT ||
    manifest.minUpdater !== 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.id || "") ||
    manifest.id !== manifestId(manifest)
  )
    throw Error("Invalid or unsupported release manifest");
  if (
    !Number.isInteger(manifest.minNodeMajor) ||
    manifest.minNodeMajor < 18 ||
    manifest.minNodeMajor > +process.versions.node.split(".")[0]
  )
    throw Error("Release requires a different Node version");
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 2048
  )
    throw Error("Invalid release file count");
  const names = new Set();
  let total = 0;
  for (const file of manifest.files) {
    if (
      !file ||
      !safeName(file.name) ||
      names.has(file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 16 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256 || "") ||
      ![0o644, 0o755].includes(file.mode)
    )
      throw Error("Invalid release file");
    names.add(file.name);
    total += file.size;
  }
  if (
    total > MAX_BYTES ||
    !names.has("package.json") ||
    !names.has("package-lock.json")
  )
    throw Error("Release is incomplete or too large");
  for (const role of ["client", "server"])
    if (
      !safeName(manifest.entries?.[role]) ||
      !names.has(manifest.entries[role]) ||
      !manifest.entries[role].endsWith(".js")
    )
      throw Error("Missing release entry point");
  return manifest;
}
function buildRelease(root) {
  const published = readJson(path.join(root, "release-manifest.json"));
  if (published) return validateManifest(published);
  // The publisher chooses trusted local source. Only JSON is sent to receivers.
  const inventory = path.join(root, "managed-files.js");
  delete require.cache[require.resolve(inventory)];
  const names = new Set([
    ...require(inventory).DEPLOY_FILES,
    "package.json",
    "package-lock.json",
  ]);
  const walk = (dir) => {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const ent of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const n = dir + "/" + ent.name;
      if (ent.isDirectory()) walk(n);
      else if (ent.isFile()) names.add(n);
      else throw Error("Release sources cannot contain symlinks");
    }
  };
  walk("public");
  const pkg = readJson(path.join(root, "package.json"));
  const files = [...names].sort().map((name) => {
    if (!safeName(name))
      throw Error("Private or invalid release source: " + name);
    const info = fs.lstatSync(path.join(root, name));
    if (!info.isFile()) throw Error("Expected regular release file: " + name);
    const data = fs.readFileSync(path.join(root, name));
    return {
      name,
      size: data.length,
      sha256: digest(data),
      mode: info.mode & 0o111 ? 0o755 : 0o644,
    };
  });
  const manifest = {
    format: FORMAT,
    minUpdater: 1,
    minNodeMajor: +(
      String(pkg.engines?.node || ">=20").match(/\d+/)?.[0] || 20
    ),
    entries: { server: "server.js", client: "client.js" },
    files,
  };
  manifest.id = manifestId(manifest);
  return validateManifest(manifest);
}
function processStamp(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return null;
  }
}
function isAlive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || !owner.start) return false;
  return processStamp(owner.pid) === owner.start;
}
function lock(root) {
  fs.mkdirSync(store(root), { recursive: true, mode: 0o700 });
  const dir = path.join(store(root), "update.lock"),
    token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      writeJson(path.join(dir, "owner.json"), {
        pid: process.pid,
        start: processStamp(process.pid),
        token,
      });
      return () => {
        if (readJson(path.join(dir, "owner.json"))?.token === token)
          fs.rmSync(dir, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readJson(path.join(dir, "owner.json"));
      // Do not steal the mkdir -> owner-write window. An ownerless directory
      // left by a crash can be reclaimed after that short window has passed.
      if (
        (!owner && Date.now() - fs.statSync(dir).mtimeMs < 30000) ||
        isAlive(owner)
      )
        throw Error("Another update is in progress");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  throw Error("Another update is in progress");
}
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeout || 10000,
    );
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(Error("Preparation command failed"));
    });
  });
}
async function installDependencies(root, dir, progress, signal) {
  progress("dependencies");
  const equal = (name) => {
    try {
      return (
        digest(fs.readFileSync(path.join(root, name))) ===
        digest(fs.readFileSync(path.join(dir, name)))
      );
    } catch {
      return false;
    }
  };
  if (
    equal("package.json") &&
    equal("package-lock.json") &&
    fs.existsSync(path.join(root, "node_modules"))
  ) {
    fs.symlinkSync(
      fs.realpathSync(path.join(root, "node_modules")),
      path.join(dir, "node_modules"),
      "dir",
    );
    return;
  }
  const npm = path.join(path.dirname(process.execPath), "npm");
  const output = path.join(dir, "dependency-install.log");
  const fd = fs.openSync(output, "w", 0o600);
  try {
    await run(
      process.execPath,
      [fs.realpathSync(npm), "ci", "--omit=dev", "--no-audit", "--no-fund"],
      { cwd: dir, timeout: 180000, signal, stdio: ["ignore", fd, fd] },
    );
  } catch {
    fs.copyFileSync(output, path.join(store(root), "last-preparation.log"));
    throw Error(
      "Dependency preparation failed; see local .swt/last-preparation.log",
    );
  } finally {
    fs.closeSync(fd);
  }
}
class ReleaseReceiver {
  constructor(root, manifest, progress = () => {}) {
    this.root = root;
    this.manifest = validateManifest(manifest);
    this.progress = progress;
    this.controller = new AbortController();
    this.unlock = lock(root);
    try {
      const activation = readJson(path.join(store(root), "activation.json"));
      if (activation?.phase === "checking")
        throw Error("A release is awaiting health checks");
      this.dir = fs.mkdtempSync(path.join(store(root), "receiving-"));
      this.offsets = manifest.files.map(() => 0);
      for (const f of manifest.files) {
        fs.mkdirSync(path.dirname(path.join(this.dir, f.name)), {
          recursive: true,
        });
        fs.writeFileSync(path.join(this.dir, f.name), "", {
          flag: "wx",
          mode: f.mode,
        });
      }
      progress("downloading");
    } catch (e) {
      this.abort();
      throw e;
    }
  }
  chunk(index, offset, data) {
    const f = this.manifest.files[index];
    if (
      !f ||
      !Number.isInteger(index) ||
      offset !== this.offsets[index] ||
      typeof data !== "string" ||
      data.length > (CHUNK_BYTES * 4) / 3 + 4
    )
      throw Error("Invalid release chunk");
    const bytes = Buffer.from(data, "base64");
    if (
      bytes.toString("base64") !== data ||
      !bytes.length ||
      bytes.length > CHUNK_BYTES ||
      offset + bytes.length > f.size
    )
      throw Error("Invalid release bytes");
    fs.appendFileSync(path.join(this.dir, f.name), bytes);
    this.offsets[index] += bytes.length;
  }
  async finish() {
    try {
      this.progress("verifying");
      this.manifest.files.forEach((f, i) => {
        if (
          this.offsets[i] !== f.size ||
          digest(fs.readFileSync(path.join(this.dir, f.name))) !== f.sha256
        )
          throw Error("Incomplete or corrupt release: " + f.name);
      });
      writeJson(path.join(this.dir, "release-manifest.json"), this.manifest);
      await installDependencies(
        this.root,
        this.dir,
        this.progress,
        this.controller.signal,
      );
      this.progress("checking");
      for (const f of this.manifest.files.filter((f) =>
        /\.[cm]?js$/.test(f.name),
      ))
        await run(process.execPath, ["--check", path.join(this.dir, f.name)], {
          timeout: 10000,
          signal: this.controller.signal,
          stdio: "ignore",
        });
      if (this.controller.signal.aborted)
        throw Error("Release preparation cancelled");
      const target = path.join(store(this.root), "releases", this.manifest.id);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (fs.existsSync(target)) {
        const existing = validateManifest(
          readJson(path.join(target, "release-manifest.json")),
        );
        if (
          existing.id !== this.manifest.id ||
          existing.files.some(
            (f) =>
              digest(fs.readFileSync(path.join(target, f.name))) !== f.sha256,
          )
        )
          throw Error("Existing release is damaged");
        fs.rmSync(this.dir, { recursive: true, force: true });
      } else fs.renameSync(this.dir, target);
      this.dir = null;
      writeJson(path.join(store(this.root), "prepared.json"), {
        id: this.manifest.id,
        preparedAt: new Date().toISOString(),
      });
      this.progress("prepared");
      return this.manifest.id;
    } finally {
      this.abort();
    }
  }
  abort() {
    this.controller.abort();
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
    if (this.unlock) this.unlock();
    this.unlock = null;
  }
}
async function sendRelease(socket, reqId, root, manifest = buildRelease(root)) {
  const send = (msg) => {
    if (socket.readyState !== 1) throw Error("Release connection closed");
    socket.send(JSON.stringify({ reqId, ...msg }));
  };
  send({ type: "release_begin", manifest });
  for (let index = 0; index < manifest.files.length; index++) {
    const data = fs.readFileSync(path.join(root, manifest.files[index].name));
    if (digest(data) !== manifest.files[index].sha256)
      throw Error("Release source changed during transfer");
    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
      while (socket.bufferedAmount > 512 * 1024) {
        if (socket.readyState !== 1) throw Error("Release connection closed");
        await new Promise((r) => setTimeout(r, 10));
      }
      send({
        type: "release_chunk",
        index,
        offset,
        data: data.subarray(offset, offset + CHUNK_BYTES).toString("base64"),
      });
    }
  }
  send({ type: "release_end" });
  return manifest.id;
}
module.exports = {
  FORMAT,
  CHUNK_BYTES,
  digest,
  store,
  readJson,
  writeJson,
  validateManifest,
  buildRelease,
  processStamp,
  isAlive,
  lock,
  ReleaseReceiver,
  sendRelease,
};
