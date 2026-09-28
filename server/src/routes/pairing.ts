import { Router } from "express";
import { z } from "zod";
import { pairingStore } from "../lib/pairing";
import { requireAuth } from "../middleware/auth";
import { generateRawToken, hashToken } from "../lib/crypto";
import { asyncHandler } from "../lib/http-error";
import { prisma } from "../db";

const router = Router();

const pairRequestSchema = z.object({
  deviceName: z.string().trim().min(1).max(64).optional(),
  os: z.string().trim().max(32).optional(),
  webUrl: z.string().url().optional(),
});

const pairApproveSchema = z.object({
  code: z.string().trim().min(1).max(32),
});

const pairPollSchema = z.object({
  deviceCode: z.string().trim().min(1).max(128),
});

// Device requests a pairing code (unauthenticated)
router.post("/tracker/pair/request", (req, res) => {
  const parsed = pairRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request payload" });
    return;
  }

  const { deviceName, os, webUrl } = parsed.data;
  const session = pairingStore.createSession(deviceName ?? "My Device", os ?? "unknown", webUrl);
  res.json(session);
});

// Browser gets session info to show what device is requesting connection
router.get("/tracker/pair/info", (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    res.status(400).json({ error: "Missing code query parameter" });
    return;
  }

  const info = pairingStore.getInfo(code);
  res.json(info);
});

// Authenticated user in browser approves device connection
router.post("/tracker/pair/approve", requireAuth, asyncHandler(async (req, res) => {
  const parsed = pairApproveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }

  const { code } = parsed.data;
  const info = pairingStore.getInfo(code);
  const userId = req.user!.id;
  const approved = { ok: true, deviceName: info.deviceName, os: info.os, username: req.user!.username };
  // Reserve before minting: a second Allow used to store a token nobody would ever
  // receive - a phantom device in Settings - and then answer with an error.
  const reservation = info.valid ? pairingStore.reserve(code, userId) : "invalid";
  if (reservation === "invalid") {
    res.status(404).json({ error: "Pairing session not found or expired" });
    return;
  }
  if (reservation === "taken") {
    res.status(409).json({ error: "This code was already used. Start pairing again on the device." });
    return;
  }
  if (reservation === "mine") {
    // Already allowed by this account (reload, second tab): the device collects the
    // first token, so this is the same success, not a new device.
    res.json(approved);
    return;
  }

  const rawToken = generateRawToken();
  const label = `${info.deviceName || "Device"} (${info.os || "unknown"})`;
  let row: { id: string };
  try {
    row = await prisma.trackerToken.create({
      data: {
        userId,
        label,
        tokenHash: hashToken(rawToken),
      },
      select: { id: true },
    });
  } catch (err) {
    pairingStore.release(code, userId);
    throw err;
  }

  if (!pairingStore.issue(code, userId, rawToken)) {
    // Expired while the row was written: nobody can collect it, so it must not linger.
    await prisma.trackerToken.delete({ where: { id: row.id } }).catch(() => undefined);
    res.status(404).json({ error: "Pairing session not found or expired" });
    return;
  }

  res.json(approved);
}));

// Device polls for pairing outcome (unauthenticated, requires secret deviceCode)
router.post("/tracker/pair/poll", asyncHandler(async (req, res) => {
  const parsed = pairPollSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid device code" });
    return;
  }

  const { deviceCode } = parsed.data;
  const result = pairingStore.poll(deviceCode);

  if (result.status === "expired") {
    res.json({ status: "expired" });
    return;
  }

  if (result.status === "pending") {
    res.json({ status: "pending" });
    return;
  }

  if (result.status === "approved" && result.token && result.userId) {
    const user = await prisma.user.findUnique({
      where: { id: result.userId },
      select: { username: true },
    });
    res.json({
      status: "approved",
      token: result.token,
      username: user?.username ?? "user",
    });
    return;
  }

  res.json({ status: "pending" });
}));

export default router;
