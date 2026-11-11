"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  store,
  readJson,
  buildRelease,
  ReleaseReceiver,
  sendRelease,
} = require("./release-package");
const runtime = require("./release-runtime");
const send = (ws, msg) => {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
};
const PHASES = {
  downloading: "下载中",
  dependencies: "准备依赖",
  verifying: "校验文件",
  checking: "检查代码",
  prepared: "已准备，等待应用",
  activating: "切换并检查健康状态",
};
function createReleaseClient({ root, config }) {
  const install = runtime.installRoot(root);
  let incoming = null;
  function disconnected(ws) {
    if (incoming?.ws === ws) {
      clearTimeout(incoming.timer);
      incoming.receiver.abort();
      incoming = null;
    }
  }
  function handle(msg, ws) {
    if (msg.type === "release_registered") {
      runtime.notifyReady();
      return true;
    }
    if (msg.type === "release_query") {
      send(ws, {
        type: "release_state",
        reqId: msg.reqId,
        ...runtime.identity(root),
      });
      return true;
    }
    if (msg.type === "release_cancel") {
      if (incoming?.reqId === msg.reqId) disconnected(ws);
      return true;
    }
    if (
      ![
        "release_export",
        "release_begin",
        "release_chunk",
        "release_end",
        "release_activate",
      ].includes(msg.type)
    )
      return false;
    const fail = (e) => {
      send(ws, {
        type: "release_status",
        reqId: msg.reqId,
        ok: false,
        error: e.message,
      });
      if (incoming?.reqId === msg.reqId) disconnected(ws);
    };
    try {
      if (msg.type === "release_export") {
        // A local publisher may serve a newer tree without changing its running monitor.
        const source = config.client?.releaseSource || root;
        sendRelease(ws, msg.reqId, source).catch(fail);
      } else if (msg.type === "release_begin") {
        if (incoming) throw Error("Another transfer is in progress");
        const receiver = new ReleaseReceiver(install, msg.manifest, (phase) =>
          send(ws, {
            type: "release_status",
            reqId: msg.reqId,
            ok: true,
            phase,
            message: PHASES[phase],
          }),
        );
        incoming = {
          ws,
          reqId: msg.reqId,
          receiver,
          timer: setTimeout(
            () => fail(Error("Release transfer timed out")),
            240000,
          ),
        };
        incoming.timer.unref();
      } else if (msg.type === "release_activate") {
        runtime.activate(install, msg.releaseId);
        send(ws, {
          type: "release_status",
          reqId: msg.reqId,
          ok: true,
          phase: "activating",
          releaseId: msg.releaseId,
        });
      } else {
        if (!incoming || incoming.ws !== ws || incoming.reqId !== msg.reqId)
          throw Error("Unknown release transfer");
        const transfer = incoming;
        if (msg.type === "release_chunk")
          transfer.receiver.chunk(msg.index, msg.offset, msg.data);
        else {
          if (transfer.finishing)
            throw Error("Transfer is already being prepared");
          transfer.finishing = true;
          transfer.receiver
            .finish()
            .then((id) => {
              clearTimeout(transfer.timer);
              if (incoming === transfer) incoming = null;
              send(ws, {
                type: "release_prepared",
                reqId: msg.reqId,
                releaseId: id,
                ok: true,
              });
            })
            .catch(fail);
        }
      }
    } catch (e) {
      fail(e);
    }
    return true;
  }
  return {
    identity: () => runtime.identity(root),
    disconnected,
    handle,
  };
}
function createReleaseServer({ root, config, agents, browsers, httpServer }) {
  const install = runtime.installRoot(root),
    jobs = new Map();
  httpServer.on("listening", runtime.notifyReady);
  const peers = (user, cid) =>
    [...agents].filter(
      ([ws, a]) =>
        ws.readyState === 1 && a.user === user && a.attrs?.clientId === cid,
    );
  function progress(job, phase, message) {
    job.phase = phase;
    send(job.browser, {
      type: "release_progress",
      reqId: job.reqId,
      clientId: job.cid,
      phase,
      message: message || PHASES[phase] || phase,
    });
  }
  function finish(job, ok, error, extra = {}) {
    if (!jobs.has(job.id)) return;
    jobs.delete(job.id);
    clearTimeout(job.timer);
    job.receiver?.abort();
    if (!ok)
      for (const group of job.groups?.values() || [])
        send(group.ws, { type: "release_cancel", reqId: job.id });
    send(job.browser, {
      type: job.kind === "pull" ? "pull_update_result" : "push_update_result",
      reqId: job.reqId,
      clientId: job.cid,
      agentName: job.name,
      ok,
      error,
      message: ok
        ? job.kind === "pull"
          ? "完整版本已准备，点击重启服务器应用"
          : "所有监控进程已运行新版本"
        : undefined,
      ...extra,
    });
  }
  function jobFor(browser, msg, kind, cid = msg.clientId, reqId = msg.reqId) {
    const user = browsers.get(browser)?.user;
    const matches = peers(user, cid);
    if (!matches.length) throw Error("Agent offline or inaccessible");
    const job = {
      id: crypto.randomUUID(),
      reqId,
      kind,
      browser,
      user,
      cid,
      name: matches[0][1].name,
      socket: matches[0][0],
      phase: "starting",
    };
    job.timer = setTimeout(
      () =>
        finish(
          job,
          false,
          "更新超时；请检查版本状态，原版本会在健康检查失败时自动恢复",
        ),
      240000,
    );
    job.timer.unref();
    jobs.set(job.id, job);
    return job;
  }
  function startPush(job) {
    const matches = peers(job.user, job.cid);
    if (matches.some(([, a]) => a.updateProtocol !== 1 || !a.installationId))
      throw Error("节点不支持当前完整版本更新协议，请更新安装后重试");
    // Each independent installation receives once; its launcher switches every monitor.
    const groups = new Map();
    for (const [ws, a] of matches)
      if (!groups.has(a.installationId))
        groups.set(a.installationId, { ws, info: a });
    job.groups = groups;
    job.expected = matches.map(([, a]) => ({
      installationId: a.installationId,
      screen: a.screen,
    }));
    job.release = buildRelease(root);
    progress(job, "downloading");
    for (const group of groups.values())
      sendRelease(group.ws, job.id, root, job.release).catch((e) =>
        finish(job, false, e.message),
      );
  }
  function registered(ws, info, msg) {
    Object.assign(info, {
      updateProtocol: msg.updateProtocol,
      installationId: msg.installationId,
      releaseId: msg.releaseId,
      updateState: msg.updateState,
    });
    if (info.updateProtocol === 1) send(ws, { type: "release_registered" });
  }
  function disconnected(ws) {
    for (const job of jobs.values()) {
      if (job.kind === "pull" && job.socket === ws)
        finish(job, false, "版本来源断开连接");
      // During activation the old agent must disconnect; registration confirms the replacement.
      if (
        job.kind === "push" &&
        job.phase !== "activating" &&
        [...(job.groups?.values() || [])].some((g) => g.ws === ws)
      )
        finish(job, false, "更新传输连接中断");
    }
  }
  function handle(role, ws, msg) {
    if (
      role === "browser" &&
      [
        "push_update",
        "push_update_all",
        "pull_update",
        "restart_server",
      ].includes(msg.type)
    ) {
      if (typeof msg.reqId !== "string" || !msg.reqId || msg.reqId.length > 200)
        return true;
      try {
        if (msg.type === "restart_server") {
          const prepared = readJson(path.join(store(install), "prepared.json"));
          if (!prepared) throw Error("没有已准备好的完整版本，请先拉取版本");
          const state = runtime.activate(install, prepared.id);
          send(ws, {
            type: "restart_server_result",
            reqId: msg.reqId,
            ok: true,
            message: "完整版本正在切换；重新连接后显示健康检查结果",
            releaseId: state.id,
          });
          return true;
        }
        const user = browsers.get(ws)?.user;
        if (msg.type === "push_update_all") {
          const ids = new Set(
            [...agents.values()]
              .filter((a) => a.user === user)
              .map((a) => a.attrs?.clientId)
              .filter(Boolean),
          );
          for (const cid of ids) {
            const job = jobFor(ws, msg, "push", cid, msg.reqId + "-" + cid);
            try {
              startPush(job);
            } catch (e) {
              finish(job, false, e.message);
            }
          }
        } else if (msg.type === "push_update") {
          const job = jobFor(ws, msg, "push");
          try {
            startPush(job);
          } catch (e) {
            finish(job, false, e.message);
          }
        } else {
          const matches = peers(user, msg.clientId);
          if (matches.length && matches[0][1].updateProtocol !== 1)
            throw Error("版本源不支持当前完整版本更新协议");
          const job = jobFor(ws, msg, "pull");
          progress(job, "downloading");
          send(job.socket, { type: "release_export", reqId: job.id });
        }
      } catch (e) {
        send(ws, {
          type:
            msg.type === "pull_update"
              ? "pull_update_result"
              : msg.type === "restart_server"
                ? "restart_server_result"
                : "push_update_result",
          reqId: msg.reqId,
          ok: false,
          error: e.message,
        });
      }
      return true;
    }
    if (role !== "agent") return false;
    if (msg.type === "release_state") {
      const info = agents.get(ws);
      if (
        info?.updateProtocol === 1 &&
        info.installationId === msg.installationId
      )
        Object.assign(info, {
          releaseId: msg.releaseId,
          updateState: msg.updateState,
        });
      return true;
    }
    const job = jobs.get(msg.reqId);
    if (!job)
      return typeof msg.type === "string" && msg.type.startsWith("release_");
    try {
      if (typeof msg.type !== "string" || !msg.type.startsWith("release_"))
        return false;
      if (job.kind === "pull") {
        if (ws !== job.socket) return true;
        if (msg.type === "release_status" && !msg.ok) throw Error(msg.error);
        if (msg.type === "release_begin") {
          if (job.receiver) throw Error("Repeated release manifest");
          job.receiver = new ReleaseReceiver(install, msg.manifest, (phase) =>
            progress(job, phase),
          );
        } else if (msg.type === "release_chunk") {
          if (!job.receiver || job.finishing)
            throw Error("Unexpected release chunk");
          job.receiver.chunk(msg.index, msg.offset, msg.data);
        } else if (msg.type === "release_end") {
          if (!job.receiver || job.finishing)
            throw Error("Unexpected release end");
          job.finishing = true;
          job.receiver
            .finish()
            .then((id) =>
              finish(job, true, null, { releaseId: id, prepared: true }),
            )
            .catch((e) => finish(job, false, e.message));
        }
      } else {
        const group = [...(job.groups?.values() || [])].find(
          (g) => g.ws === ws,
        );
        if (!group) return true;
        if (msg.ok === false) throw Error(msg.error || "Release rejected");
        if (msg.type === "release_status")
          progress(job, msg.phase, msg.message);
        if (msg.type === "release_prepared") {
          if (msg.releaseId !== job.release.id)
            throw Error("Unexpected prepared release");
          group.prepared = true;
          if ([...job.groups.values()].every((g) => g.prepared)) {
            progress(job, "activating");
            for (const g of job.groups.values())
              send(g.ws, {
                type: "release_activate",
                reqId: job.id,
                releaseId: job.release.id,
              });
          }
        }
      }
    } catch (e) {
      finish(job, false, e.message);
    }
    return true;
  }
  let lastPhase;
  const timer = setInterval(() => {
    const status = runtime.identity(root),
      phase = status.updateState?.phase;
    if (phase !== lastPhase) {
      lastPhase = phase;
      for (const ws of browsers.keys())
        send(ws, { type: "release_server_status", ...status });
    }
    for (const job of jobs.values())
      if (job.kind === "push" && job.phase === "activating") {
        const live = peers(job.user, job.cid).map(([, a]) => a);
        const failed = live.find(
          (a) =>
            a.updateState?.id === job.release.id &&
            a.updateState.phase === "rolled_back",
        );
        if (failed) {
          finish(job, false, failed.updateState.error || "新版本已回滚");
          continue;
        }
        if (
          job.expected.every((e) =>
            live.some(
              (a) =>
                a.installationId === e.installationId &&
                a.screen === e.screen &&
                a.releaseId === job.release.id &&
                a.updateState?.phase === "completed",
            ),
          )
        )
          finish(job, true, null, { releaseId: job.release.id });
        // Registrations happen before the launcher's health grace period. Query it afterwards.
        for (const [aws, a] of peers(job.user, job.cid))
          if (a.updateProtocol === 1)
            send(aws, { type: "release_query", reqId: job.id });
      }
  }, 500);
  timer.unref();
  httpServer.once("close", () => {
    clearInterval(timer);
    for (const job of jobs.values()) finish(job, false, "服务器已关闭");
  });
  return {
    registered,
    disconnected,
    handle,
    status: () => runtime.identity(root),
  };
}
module.exports = { createReleaseClient, createReleaseServer };
