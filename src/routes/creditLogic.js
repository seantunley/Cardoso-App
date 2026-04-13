import express from "express";
import {
  applySyncedCreditLogic,
  authenticateSiteAgainstHub,
  ensureCreditLogicBootstrap,
  getActiveCreditLogicVersion,
  getCreditLogicForAnalysis,
  getHubCreditLogicPayloadForSite,
  getHubCreditLogicSiteStatuses,
  getLocalCreditLogicState,
  listCreditLogicVersions,
  publishCreditLogicVersion,
  pushCreditLogicToSites,
  syncCreditLogicFromHub,
  updateHubSiteCreditLogicStatus,
} from "../services/creditLogic.js";
import { debugCreditForCustomer } from "../services/creditDebug.js";

export function createCreditLogicRouter({ requireAuth, requirePermission }) {
  const router = express.Router();
  const canManageCreditLogic = [requireAuth, requirePermission("can_manage_rules")];
  ensureCreditLogicBootstrap();

  router.get("/api/credit-logic/current", requireAuth, (req, res) => {
    const current = getLocalCreditLogicState();
    const active = getActiveCreditLogicVersion();
    res.json({
      mode: process.env.HUB_MODE === "true" ? "hub" : "site",
      current,
      latestVersion: active.version,
      analysis: getCreditLogicForAnalysis(),
      hubSyncConfigured: Boolean(process.env.HUB_MODE === "true" || process.env.HUB_SYNC_URL || process.env.HUB_REDIRECT_URL),
    });
  });

  router.post("/api/credit-logic/sync-from-hub", ...canManageCreditLogic, async (req, res) => {
    if (process.env.HUB_MODE === "true") return res.status(400).json({ error: "Hub instances already use the source-of-truth config locally." });
    try {
      const result = await syncCreditLogicFromHub({ triggeredBy: req.currentUser?.email || "manual" });
      res.status(result.ok ? 200 : 207).json(result);
    } catch (err) {
      console.error('[credit-logic] sync-from-hub error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/api/hub/credit-logic", ...canManageCreditLogic, (req, res) => {
    if (process.env.HUB_MODE !== "true") return res.status(400).json({ error: "Not running in hub mode" });
    const active = getActiveCreditLogicVersion();
    res.json({ current: active, versions: listCreditLogicVersions(), siteStatuses: getHubCreditLogicSiteStatuses() });
  });

  router.post("/api/hub/credit-logic/publish", ...canManageCreditLogic, (req, res) => {
    if (process.env.HUB_MODE !== "true") return res.status(400).json({ error: "Not running in hub mode" });
    try {
      const published = publishCreditLogicVersion({ config: req.body?.config, notes: req.body?.notes || null, createdBy: req.currentUser?.email || null });
      res.status(201).json({ current: published, versions: listCreditLogicVersions(), siteStatuses: getHubCreditLogicSiteStatuses() });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message, details: error.details || null });
    }
  });

  router.post("/api/hub/credit-logic/push", ...canManageCreditLogic, async (req, res) => {
    if (process.env.HUB_MODE !== "true") return res.status(400).json({ error: "Not running in hub mode" });
    try {
      const result = await pushCreditLogicToSites({ siteIds: Array.isArray(req.body?.site_ids) ? req.body.site_ids : null });
      res.status(result.failed === 0 ? 200 : 207).json({ ...result, siteStatuses: getHubCreditLogicSiteStatuses() });
    } catch (err) {
      console.error('[credit-logic] push-to-sites error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/api/hub/credit-logic/published", (req, res) => {
    if (process.env.HUB_MODE !== "true") return res.status(404).json({ error: "Not running in hub mode" });
    const siteId = authenticateSiteAgainstHub(req);
    if (!siteId) return res.status(401).json({ error: "Unauthorized" });
    try {
      res.json(getHubCreditLogicPayloadForSite(siteId));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  router.post("/api/hub/credit-logic/site-status", express.json(), (req, res) => {
    if (process.env.HUB_MODE !== "true") return res.status(404).json({ error: "Not running in hub mode" });
    const siteId = authenticateSiteAgainstHub(req);
    if (!siteId) return res.status(401).json({ error: "Unauthorized" });
    updateHubSiteCreditLogicStatus({
      siteId,
      logicVersion: req.body?.logic_version ?? null,
      syncStatus: req.body?.sync_status || "never_synced",
      lastError: req.body?.last_error || null,
      lastSyncedAt: req.body?.last_synced_at || null,
    });
    res.json({ ok: true });
  });

  router.post("/api/hub/receive-credit-logic", express.json(), (req, res) => {
    const token = req.headers["x-reporting-token"];
    if (!process.env.REPORTING_TOKEN || token !== process.env.REPORTING_TOKEN) return res.status(401).json({ error: "Unauthorized" });
    try {
      const state = applySyncedCreditLogic({ version: req.body?.version, config: req.body?.config, publishedAt: req.body?.publishedAt || null, syncStatus: "current", source: "hub" });
      res.json({ ok: true, logicVersion: state.logicVersion, syncStatus: state.syncStatus, lastSyncedAt: state.lastSyncedAt });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message, details: error.details || null });
    }
  });

  router.get("/api/credit-logic/debug", requireAuth, (req, res) => {
    const customerNumber = typeof req.query.customer === "string" ? req.query.customer.trim() : "";
    if (!customerNumber) return res.status(400).json({ error: "customer query parameter is required" });
    try {
      const result = debugCreditForCustomer(customerNumber);
      res.json(result);
    } catch (err) {
      console.error("[credit-debug] error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
