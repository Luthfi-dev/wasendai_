import makeWASocketImport, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
} from '@whiskeysockets/baileys';
import crypto from 'crypto';
import pino from 'pino';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import {
  updateSession,
  addSession,
  deleteSession,
  getSessionById,
  getSessionsByUserId,
  getWhatsAppSessions,
  addMessageLog,
  addBroadcastHistory,
  getAutoReplyRules,
  getAntiBanSettings,
  getSystemConfig,
  getUserById,
  canUseAiQuota,
  deductUserAiQuota,
  deductUserDailyQuota,
  initDbFile,
  extractUserIdFromSessionId,
  isSessionOwnedByUserId,
  getActiveCatalogForAi,
  resolveOrderNotificationRecipientPhone,
  getSuperadminWaQueue,
  enqueueSuperadminWaMessage,
  updateSuperadminWaQueueItem,
  removeSuperadminWaQueueItem,
  isPhoneMetaAiVerifiedForUser,
  markUserMetaAiVerified,
  updateUser,
  resolveEffectiveSessionAiSettings,
  getWhitelabelConfig,
  resolvePublicAppBaseUrl,
  hasSessionExpiryAlertSent,
  markSessionExpiryAlertSent,
  clearSessionExpiryAlertSent,
  getPendingSessionExpiryAlerts,
  upsertPendingSessionExpiryAlert,
  removePendingSessionExpiryAlert,
  clearPendingSessionExpiryAlertsByKeys,
  getUserAutoReplyStatus
} from './db.js';
import {
  askMetaAiViaBaileys,
  attachMetaAiRawSocketHandlers,
  clearMetaAiSession,
  handleMetaAiIncomingUpdate,
  handleMetaAiIncomingUpsert,
  isMetaAiJid,
  registerConnectedSocketProvider,
  type ConnectedSocketEntry
} from './metaAiService.js';
import {
  isMysqlConfigured,
  saveBaileysAuthToMysql,
  loadBaileysAuthFromMysql,
  loadAllBaileysAuthSessionIdsFromMysql,
  deleteBaileysAuthFromMysql
} from './mysqlService.js';
import {
  buildDeterministicOrderFallbackReply,
  completeAndConsumeVerifiedPaidOrder,
  formatOwnerOrderNotificationMessage,
  parseAndHandleAiPaymentDirectives,
  prepareOrderFlowForIncomingMessage,
  recordCustomerTurn
} from './orderAssistant.js';

// Consistent Browser & Version across ALL Baileys sockets (prevents "Periksa nomor dengan benar" on pairing restart)
export const BAILEYS_BROWSER: [string, string, string] = ['Ubuntu', 'Chrome', '22.04.4'];
export const DEFAULT_BAILEYS_VERSION: [number, number, number] = [2, 3000, 1043857760];
const BAILEYS_SILENT_LOGGER = pino({ level: 'silent' });

let cachedBaileysVersion: [number, number, number] | null = null;
let versionFetchPromise: Promise<[number, number, number]> | null = null;

async function resolveBaileysVersion(): Promise<[number, number, number]> {
  if (cachedBaileysVersion) return cachedBaileysVersion;
  if (versionFetchPromise) return versionFetchPromise;

  versionFetchPromise = Promise.race([
    fetchLatestBaileysVersion().then(res => res.version as [number, number, number]),
    new Promise<[number, number, number]>(resolve =>
      setTimeout(() => resolve(DEFAULT_BAILEYS_VERSION), 3500)
    )
  ])
    .catch(() => DEFAULT_BAILEYS_VERSION)
    .then(ver => {
      cachedBaileysVersion = ver || DEFAULT_BAILEYS_VERSION;
      versionFetchPromise = null;
      return cachedBaileysVersion;
    });

  return versionFetchPromise;
}

function isSocketTrulyOpen(sock: any): boolean {
  if (!sock) return false;
  if (sock.ws) {
    if (typeof sock.ws.isOpen === 'boolean') return sock.ws.isOpen;
    if (typeof sock.ws.readyState === 'number') return sock.ws.readyState === 1;
  }
  return true;
}

// Normalize phone number to international WhatsApp format (e.g. 0812..., 812..., +62812... -> 62812...)
export function normalizePhoneNumber(phone: string): string {
  if (!phone) return '';
  let clean = phone.replace(/\D/g, '');
  if (clean.startsWith('00')) {
    clean = clean.slice(2);
  }
  if (clean.startsWith('620')) {
    clean = '62' + clean.slice(3);
  } else if (clean.startsWith('0')) {
    clean = '62' + clean.slice(1);
  } else if (clean.startsWith('8')) {
    clean = '62' + clean;
  }
  return clean;
}

// Handle ESM/CJS default export compatibility for Baileys
const makeWASocket = (makeWASocketImport as any).default || makeWASocketImport;

interface SessionState {
  sessionId: string;
  userId?: string;
  socket: any;
  qrCodeUrl: string | null;
  pairingCode: string | null;
  status: 'connecting' | 'connected' | 'disconnected';
  phoneNumber: string | null;
  lastUpdated: number;
  lastOutgoingAt?: number;
  handshakeStartedAt: number;
  retryCount: number;
  disconnectedSince?: number;
  is_primary?: boolean;
  detachRawHandlers?: () => void;
}

const activeSessions = new Map<string, SessionState>();
const sessionStartLocks = new Map<string, Promise<SessionState>>();
const authBackupTimers = new Map<string, NodeJS.Timeout>();
const lastAuthBackupAt = new Map<string, number>();
const lastAuthBackupHashes = new Map<string, string>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const inFlightExpiryAlerts = new Set<string>();
const AUTH_DIR = path.resolve(process.cwd(), 'baileys_auth_sessions');
const UNSCANNED_HANDSHAKE_TTL_MS = 3 * 60 * 1000;
const FREE_IDLE_SOCKET_TTL_MS = 3 * 60 * 1000;
const MAX_RECONNECT_RETRIES = 5;
const AUTH_BACKUP_DEBOUNCE_MS = 30000;
const AUTH_BACKUP_COOLDOWN_MS = 120000;
const PRUNE_COOLDOWN_MS = 90000;
const MYSQL_AUTH_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const SESSION_EXPIRY_ALERT_GRACE_MS = 60 * 60 * 1000; // Tunggu 1 jam sebelum kirim WA pengingat kedaluwarsa

export function clearSessionExpiryNotificationCooldown(sessionId: string, ownerUserId?: string, phone?: string) {
  const cleanPhone = normalizePhoneNumber(phone || '');
  const keysToClear: string[] = [];
  if (sessionId) keysToClear.push(sessionId);
  if (ownerUserId) {
    if (sessionId) keysToClear.push(`${ownerUserId}:${sessionId}`);
    if (cleanPhone) keysToClear.push(`${ownerUserId}:${cleanPhone}`);
  }
  clearSessionExpiryAlertSent(keysToClear);
  clearPendingSessionExpiryAlertsByKeys({
    userId: ownerUserId,
    sessionId,
    phone: cleanPhone
  });
}

function verifyExpiredAlertState(params: {
  userId: string;
  sessionId: string;
  expiredPhone?: string;
}): 'expired' | 'recovered' | 'wait' {
  const owner = getUserById(params.userId);
  if (!isOwnerActiveAndRegistered(owner)) {
    return 'recovered';
  }

  const now = Date.now();
  const cleanPhone = normalizePhoneNumber(params.expiredPhone || '');

  // 1. Check live in-memory sockets for this user
  for (const s of activeSessions.values()) {
    const ownerMatch =
      s.userId === owner!.id ||
      isSessionOwnedByUserId(s.sessionId, owner!.id) ||
      Boolean(getSessionById(s.sessionId)?.user_id === owner!.id);
    if (!ownerMatch) continue;

    const memPhone = normalizePhoneNumber(s.phoneNumber || '');
    const sameDevice =
      s.sessionId === params.sessionId ||
      (cleanPhone.length >= 8 && memPhone === cleanPhone);
    if (!sameDevice) continue;

    if (s.status === 'connected' && isSocketTrulyOpen(s.socket)) {
      return 'recovered';
    }
    if (s.status === 'connecting' && now - s.lastUpdated < 45000) {
      return 'wait';
    }
  }

  // 2. Check persisted DB sessions for this user (covers connected & valid standby devices)
  const userDbSessions = getSessionsByUserId(owner!.id);
  for (const s of userDbSessions) {
    const dbPhone = normalizePhoneNumber(s.phone_number || '');
    const sameDevice =
      s.id === params.sessionId ||
      (cleanPhone.length >= 8 && dbPhone === cleanPhone);
    if (!sameDevice) continue;

    const notExpiredByDate = !s.expires_at || Date.parse(s.expires_at) > now;
    if (s.status === 'connected' && notExpiredByDate && hasRegisteredCredsOnDisk(s.id)) {
      return 'recovered';
    }
  }

  return 'expired';
}

function buildProfessionalExpiredSessionMessage(params: {
  ownerName: string;
  expiredPhone?: string;
  sessionName?: string;
}): string {
  const wl = getWhitelabelConfig();
  const appName = (wl?.app_name || 'Japriin').trim();
  const publicUrl = resolvePublicAppBaseUrl();
  const cleanPhone = normalizePhoneNumber(params.expiredPhone || '');
  const deviceLabel = cleanPhone
    ? `+${cleanPhone}`
    : params.sessionName && !params.sessionName.startsWith('session_')
      ? params.sessionName
      : 'Perangkat WhatsApp Anda';
  const urlBlock = publicUrl ? `\nTautan login: ${publicUrl}\n` : '\n';

  return (
    `Halo *${params.ownerName}*,\n\n` +
    `Kami informasikan bahwa tautan perangkat WhatsApp Anda (*${deviceLabel}*) di *${appName}* saat ini sudah kedaluwarsa atau terputus selama lebih dari 1 jam.\n\n` +
    `Silakan login ke akun *${appName}* Anda dan tautkan kembali perangkat pada menu *Koneksi WA* agar sesi dan layanan pengiriman pesan Anda kembali berjalan lancar.${urlBlock}\n` +
    `Terima kasih.\n` +
    `_Pesan pengingat ini hanya dikirim satu kali sampai perangkat Anda ditautkan kembali._`
  );
}

export async function notifyUserSessionExpired(params: {
  sessionId: string;
  sessionName?: string;
  expiredPhone?: string;
  userId?: string;
  reason?: string;
  graceMs?: number;
}): Promise<{ notified: boolean; skipped?: string; queued?: boolean; scheduled?: boolean }> {
  const dbSess = getSessionById(params.sessionId);
  const resolvedPhone = normalizePhoneNumber(
    params.expiredPhone || dbSess?.phone_number || getCredsPhoneOnDisk(params.sessionId) || ''
  );
  const owner = resolveActiveVerifiedOwner(params.sessionId, params.userId || dbSess?.user_id, resolvedPhone);
  if (!isOwnerActiveAndRegistered(owner)) {
    return { notified: false, skipped: 'owner_inactive' };
  }

  const recipientPhone = normalizePhoneNumber(owner!.phone || '');
  if (!recipientPhone || recipientPhone.length < 8) {
    return { notified: false, skipped: 'missing_owner_phone' };
  }

  const dedupeKeys = Array.from(
    new Set(
      [
        resolvedPhone ? `${owner!.id}:${resolvedPhone}` : `${owner!.id}:${params.sessionId}`,
        `${owner!.id}:${params.sessionId}`
      ].filter(Boolean)
    )
  );

  if (dedupeKeys.some(k => inFlightExpiryAlerts.has(k)) || hasSessionExpiryAlertSent(dedupeKeys)) {
    return { notified: false, skipped: 'already_notified_until_relogin' };
  }

  const alertKey = resolvedPhone ? `${owner!.id}:${resolvedPhone}` : `${owner!.id}:${params.sessionId}`;
  const graceMs = typeof params.graceMs === 'number' && params.graceMs >= 0 ? params.graceMs : SESSION_EXPIRY_ALERT_GRACE_MS;

  const { item, created } = upsertPendingSessionExpiryAlert({
    key: alertKey,
    user_id: owner!.id,
    session_id: params.sessionId,
    session_name: params.sessionName || dbSess?.session_name,
    expired_phone: resolvedPhone || undefined,
    reason: params.reason,
    grace_ms: graceMs
  });

  if (created) {
    console.log(
      `[Baileys Expiry Alert Scheduled] User=${owner!.username} Session=${params.sessionId} (+${resolvedPhone || '-'}) ditunda 1 jam (kirim setelah ${item.notify_after}).`
    );
  }

  return { notified: false, scheduled: true, queued: false };
}

let isProcessingPendingExpiryAlerts = false;
export async function processPendingSessionExpiryAlerts(reason = 'watchdog'): Promise<{
  checked: number;
  sent: number;
  cancelled: number;
  waiting: number;
}> {
  if (isProcessingPendingExpiryAlerts) {
    return { checked: 0, sent: 0, cancelled: 0, waiting: 0 };
  }

  const pending = getPendingSessionExpiryAlerts();
  if (pending.length === 0) {
    return { checked: 0, sent: 0, cancelled: 0, waiting: 0 };
  }

  isProcessingPendingExpiryAlerts = true;
  let checked = 0;
  let sent = 0;
  let cancelled = 0;
  let waiting = 0;

  try {
    const now = Date.now();
    for (const alert of pending) {
      checked++;

      // Selalu cek ulang status sesi user (bahkan sebelum 1 jam) agar jika sudah pulih langsung dibatalkan
      const preCheck = verifyExpiredAlertState({
        userId: alert.user_id,
        sessionId: alert.session_id,
        expiredPhone: alert.expired_phone
      });
      if (preCheck === 'recovered') {
        removePendingSessionExpiryAlert(alert.id);
        cancelled++;
        continue;
      }

      const notifyAfterMs = Date.parse(alert.notify_after || '');
      if (Number.isFinite(notifyAfterMs) && now < notifyAfterMs) {
        waiting++;
        continue;
      }

      if (preCheck === 'wait') {
        waiting++;
        continue;
      }

      const owner = getUserById(alert.user_id);
      if (!isOwnerActiveAndRegistered(owner)) {
        removePendingSessionExpiryAlert(alert.id);
        cancelled++;
        continue;
      }

      const recipientPhone = normalizePhoneNumber(owner!.phone || '');
      if (!recipientPhone || recipientPhone.length < 8) {
        removePendingSessionExpiryAlert(alert.id);
        cancelled++;
        continue;
      }

      const cleanExpiredPhone = normalizePhoneNumber(alert.expired_phone || '');
      const dedupeKeys = Array.from(
        new Set(
          [
            cleanExpiredPhone ? `${owner!.id}:${cleanExpiredPhone}` : `${owner!.id}:${alert.session_id}`,
            `${owner!.id}:${alert.session_id}`
          ].filter(Boolean)
        )
      );

      if (hasSessionExpiryAlertSent(dedupeKeys)) {
        removePendingSessionExpiryAlert(alert.id);
        cancelled++;
        continue;
      }

      // Tunggu sampai WA Superadmin benar-benar terhubung
      const saSession = resolveConnectedSuperadminSession();
      if (!saSession) {
        waiting++;
        continue;
      }

      // Hindari self-notif jika satu-satunya admin WA yang terhubung justru nomor yg sama & tidak punya sesi lain
      if (owner!.role === 'admin' && saSession.sessionId === alert.session_id) {
        waiting++;
        continue;
      }

      // Verifikasi ulang TERAKHIR tepat sebelum mengirim agar tidak salah kirim info ke user
      const finalCheck = verifyExpiredAlertState({
        userId: alert.user_id,
        sessionId: alert.session_id,
        expiredPhone: alert.expired_phone
      });
      if (finalCheck === 'recovered') {
        removePendingSessionExpiryAlert(alert.id);
        cancelled++;
        continue;
      }
      if (finalCheck === 'wait') {
        waiting++;
        continue;
      }

      if (dedupeKeys.some(k => inFlightExpiryAlerts.has(k))) {
        waiting++;
        continue;
      }

      const message = buildProfessionalExpiredSessionMessage({
        ownerName: owner!.name || owner!.username,
        expiredPhone: alert.expired_phone,
        sessionName: alert.session_name
      });

      for (const k of dedupeKeys) inFlightExpiryAlerts.add(k);
      try {
        await sendDirectlyViaSuperadminSocket(saSession, recipientPhone, message);
        markSessionExpiryAlertSent(dedupeKeys);
        removePendingSessionExpiryAlert(alert.id);
        sent++;
        console.log(
          `[Baileys Expiry Alert Sent:${reason}] User=${owner!.username} (${recipientPhone}) ExpiredPhone=+${cleanExpiredPhone || '-'} Session=${alert.session_id}`
        );
        if (pending.length > 1) {
          await delay(3500 + crypto.randomInt(0, 1500));
        }
      } catch (err: any) {
        waiting++;
        console.warn(
          `[Baileys Expiry Alert Retry] Gagal kirim notifikasi expired ke ${recipientPhone}, ditahan untuk percobaan berikutnya:`,
          err?.message || err
        );
      } finally {
        for (const k of dedupeKeys) inFlightExpiryAlerts.delete(k);
      }
    }
  } finally {
    isProcessingPendingExpiryAlerts = false;
  }

  return { checked, sent, cancelled, waiting };
}

export function buildBaileysSocketConfig(version: [number, number, number], logger: any, authState: any) {
  return {
    version,
    logger,
    printQRInTerminal: false,
    auth: authState,
    browser: BAILEYS_BROWSER,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
    linkPreviewImageThumbnailWidth: 0,
    markOnlineOnConnect: false,
    shouldIgnoreJid: (jid: string) => {
      if (!jid) return true;
      if (isMetaAiJid(jid)) return false;
      return (
        jid.endsWith('@g.us') ||
        jid === 'status@broadcast' ||
        jid.endsWith('@broadcast') ||
        jid.endsWith('@newsletter')
      );
    },
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 2,
    transactionOpts: {
      maxCommitRetries: 5,
      delayBetweenTriesMs: 1000
    }
  };
}

const ensureSessionLocks = new Map<string, Promise<ConnectedSocketEntry | null>>();

function socketMatchesUser(
  s: SessionState,
  userId: string,
  userDbSessions?: Array<{ id: string; user_id?: string; phone_number?: string }>
): boolean {
  if (!userId) return true;
  if (s.userId && s.userId !== userId) return false;
  if (s.userId === userId || isSessionOwnedByUserId(s.sessionId, userId)) {
    if (!s.userId) s.userId = userId;
    return true;
  }
  const dbSess = getSessionById(s.sessionId);
  if (dbSess?.user_id) {
    if (dbSess.user_id !== userId) return false;
    if (!s.userId) s.userId = userId;
    return true;
  }
  const ownedSessions = userDbSessions ?? getSessionsByUserId(userId);
  const memPhone = normalizePhoneNumber(s.phoneNumber || '');
  const matched = ownedSessions.some(
    dbS =>
      dbS.id === s.sessionId ||
      (memPhone.length >= 8 &&
        dbS.phone_number &&
        normalizePhoneNumber(dbS.phone_number) === memPhone)
  );
  if (matched && !s.userId) {
    s.userId = userId;
  }
  return matched;
}

function findLiveSocketEntry(
  userId?: string,
  preferredSessionId?: string
): ConnectedSocketEntry | null {
  const userDbSessions = userId ? getSessionsByUserId(userId) : undefined;
  if (preferredSessionId) {
    const pref = activeSessions.get(preferredSessionId);
    if (
      pref &&
      pref.status === 'connected' &&
      pref.socket &&
      isSocketTrulyOpen(pref.socket) &&
      (!userId || socketMatchesUser(pref, userId, userDbSessions))
    ) {
      return {
        sessionId: pref.sessionId,
        userId: pref.userId,
        phoneNumber: pref.phoneNumber || undefined,
        socket: pref.socket
      };
    }
  }

  const candidates = Array.from(activeSessions.values()).filter((s) => {
    if (s.status !== 'connected' || !s.socket || !isSocketTrulyOpen(s.socket)) return false;
    return !userId || socketMatchesUser(s, userId, userDbSessions);
  });

  const picked = candidates.find((s) => s.is_primary) || candidates[0];
  if (!picked) return null;
  return {
    sessionId: picked.sessionId,
    userId: picked.userId,
    phoneNumber: picked.phoneNumber || undefined,
    socket: picked.socket
  };
}

export async function ensureConnectedSessionForUser(
  userId?: string,
  preferredSessionId?: string
): Promise<ConnectedSocketEntry | null> {
  const immediate = findLiveSocketEntry(userId, preferredSessionId);
  if (immediate) return immediate;
  if (!userId && !preferredSessionId) return null;

  const lockKey = `${userId || ''}::${preferredSessionId || ''}`;
  const inFlight = ensureSessionLocks.get(lockKey);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<ConnectedSocketEntry | null> => {
    try {
      const userDbSessions = userId ? getSessionsByUserId(userId) : [];

      // 1. Wait briefly if an owned session is currently mid-handshake / reconnecting
      const connectingMatch = Array.from(activeSessions.values()).find((s) => {
        if (s.status !== 'connecting') return false;
        if (preferredSessionId && s.sessionId === preferredSessionId) {
          return !userId || socketMatchesUser(s, userId, userDbSessions);
        }
        return userId ? socketMatchesUser(s, userId, userDbSessions) : false;
      });

      if (connectingMatch) {
        let tries = 0;
        while (tries < 12 && connectingMatch.status === 'connecting') {
          await delay(400);
          const ready = findLiveSocketEntry(userId, preferredSessionId);
          if (ready) return ready;
          tries++;
        }
        const afterWait = findLiveSocketEntry(userId, preferredSessionId);
        if (afterWait) return afterWait;
      }

      // 2. Collect candidate DB sessions owned by this user
      const candidates: Array<{ id: string; phone?: string; userId?: string }> = [];
      const addCandidate = (id?: string, phone?: string, uid?: string) => {
        if (!id) return;
        if (!candidates.some(c => c.id === id)) {
          candidates.push({ id, phone, userId: uid });
        }
      };

      if (preferredSessionId) {
        const prefDb = getSessionById(preferredSessionId);
        if (
          !userId ||
          (prefDb
            ? prefDb.user_id === userId || isSessionOwnedByUserId(prefDb.id, userId)
            : isSessionOwnedByUserId(preferredSessionId, userId))
        ) {
          addCandidate(preferredSessionId, prefDb?.phone_number, prefDb?.user_id || userId);
        }
      }

      const sortedDb = [...userDbSessions]
        .filter(s => !s.expires_at || new Date(s.expires_at).getTime() >= Date.now())
        .sort((a, b) => {
          const scoreStatus = (st?: string) => (st === 'connected' ? 2 : st === 'connecting' ? 1 : 0);
          const statusDiff = scoreStatus(b.status) - scoreStatus(a.status);
          if (statusDiff !== 0) return statusDiff;
          return Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
        });

      for (const s of sortedDb) {
        addCandidate(s.id, s.phone_number, s.user_id || userId);
      }

      // 3. Also inspect registered disk auth folders matching user's DB session phone
      if (userId && fs.existsSync(AUTH_DIR) && sortedDb.length > 0) {
        const targetPhones = new Set(
          sortedDb.map(s => normalizePhoneNumber(s.phone_number || '')).filter(p => p.length >= 8)
        );
        for (const folder of fs.readdirSync(AUTH_DIR)) {
          const summary = readCredsSummary(folder);
          if (!summary.registered) continue;
          if (
            isSessionOwnedByUserId(folder, userId) ||
            (summary.phone && targetPhones.has(summary.phone))
          ) {
            const owner = resolveActiveVerifiedOwner(folder, undefined, summary.phone);
            if (!owner || owner.id === userId) {
              addCandidate(folder, summary.phone, userId);
            }
          }
        }
      }

      // 4. Hydrate from MySQL if needed and wake the session socket on demand (for Blast / API / AI)
      for (const cand of candidates) {
        let hasCreds = hasRegisteredCredsOnDisk(cand.id);
        if (!hasCreds) {
          hasCreds = await hydrateSessionAuthFolderFromMysql(cand.id).catch(() => false);
        }
        if (!hasCreds) continue;

        const state = await getOrStartBaileysSession(cand.id, cand.phone, cand.userId || userId);
        let tries = 0;
        while (tries < 14 && state.status === 'connecting') {
          await delay(400);
          const ready = findLiveSocketEntry(userId, preferredSessionId || cand.id);
          if (ready) {
            const activeMem = activeSessions.get(ready.sessionId);
            if (activeMem) activeMem.lastOutgoingAt = Date.now();
            return ready;
          }
          tries++;
        }
        const finalCheck = findLiveSocketEntry(userId, preferredSessionId || cand.id);
        if (finalCheck) {
          const activeMem = activeSessions.get(finalCheck.sessionId);
          if (activeMem) activeMem.lastOutgoingAt = Date.now();
          return finalCheck;
        }
      }

      return null;
    } finally {
      ensureSessionLocks.delete(lockKey);
    }
  })();

  ensureSessionLocks.set(lockKey, promise);
  return promise;
}

registerConnectedSocketProvider(
  (userId?: string, preferredSessionId?: string) => findLiveSocketEntry(userId, preferredSessionId),
  () =>
    Array.from(activeSessions.values())
      .filter((s) => s.status === 'connected' && s.socket && isSocketTrulyOpen(s.socket))
      .map((s) => ({
        sessionId: s.sessionId,
        userId: s.userId,
        phoneNumber: s.phoneNumber || undefined,
        socket: s.socket
      })),
  ensureConnectedSessionForUser
);

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
}

export function sanitizeSessionId(rawId: string): string {
  const cleaned = String(rawId || '').trim();
  if (!cleaned || !/^[a-zA-Z0-9_.-]{1,128}$/.test(cleaned) || cleaned.includes('..')) {
    throw new Error('ID sesi WhatsApp tidak valid.');
  }
  return cleaned;
}

const CATALOG_UPLOAD_DIR = path.resolve(process.cwd(), 'uploads', 'catalog');
const SAFE_LOCAL_CATALOG_FILE_RE = /^(?:prod|qris)_[a-f0-9-]+\.(png|jpg|webp|gif)$/i;

function resolveLocalCatalogImageBuffer(url?: string): Buffer | null {
  if (!url) return null;
  let relPath = String(url).trim();
  if (/^https?:\/\//i.test(relPath)) {
    try {
      relPath = new URL(relPath).pathname;
    } catch {
      return null;
    }
  }
  if (!relPath.startsWith('/api/catalog/images/')) return null;
  const filename = path.basename(relPath);
  if (!SAFE_LOCAL_CATALOG_FILE_RE.test(filename)) return null;
  const resolved = path.resolve(CATALOG_UPLOAD_DIR, filename);
  if (!resolved.startsWith(CATALOG_UPLOAD_DIR + path.sep)) return null;
  try {
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size < 50 || stat.size > 5 * 1024 * 1024) return null;
    return fs.readFileSync(resolved);
  } catch {
    return null;
  }
}

function safeSessionFolderPath(sessionId: string): string | null {
  try {
    const safeId = sanitizeSessionId(sessionId);
    const resolved = path.resolve(AUTH_DIR, safeId);
    if (!resolved.startsWith(AUTH_DIR + path.sep)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function clearSessionTimers(sessionId: string) {
  const b = authBackupTimers.get(sessionId);
  if (b) {
    clearTimeout(b);
    authBackupTimers.delete(sessionId);
  }
  const r = reconnectTimers.get(sessionId);
  if (r) {
    clearTimeout(r);
    reconnectTimers.delete(sessionId);
  }
}

function isFatalDisconnectCode(statusCode?: number): boolean {
  return (
    statusCode === DisconnectReason.loggedOut ||
    statusCode === DisconnectReason.forbidden ||
    statusCode === DisconnectReason.badSession ||
    statusCode === DisconnectReason.multideviceMismatch ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 405 ||
    statusCode === 411
  );
}

function readCredsSummary(sessionId: string): { registered: boolean; phone: string } {
  try {
    const folder = safeSessionFolderPath(sessionId);
    if (!folder) return { registered: false, phone: '' };
    const credsPath = path.join(folder, 'creds.json');
    if (!fs.existsSync(credsPath)) return { registered: false, phone: '' };
    const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    const meId = parsed?.me?.id ? String(parsed.me.id) : '';
    return {
      registered: Boolean(parsed && (parsed.registered || meId)),
      phone: meId ? normalizePhoneNumber(meId.split('@')[0].split(':')[0]) : ''
    };
  } catch {
    return { registered: false, phone: '' };
  }
}

function getCredsPhoneOnDisk(sessionId: string): string {
  return readCredsSummary(sessionId).phone;
}

function resolveActiveVerifiedOwner(sessionId: string, candidateUserId?: string, candidatePhone?: string) {
  const db = initDbFile();
  const cleanPhone = normalizePhoneNumber(candidatePhone || '');

  if (candidateUserId) {
    const u = getUserById(candidateUserId);
    if (u) return u;
  }

  const dbSess = getSessionById(sessionId);
  if (dbSess?.user_id) {
    const u = getUserById(dbSess.user_id);
    if (u) return u;
  }

  const extractedId = extractUserIdFromSessionId(sessionId, db.users);
  if (extractedId) {
    const u = getUserById(extractedId);
    if (u) return u;
  }

  if (cleanPhone && cleanPhone.length >= 8) {
    const matchedSessionOwner = db.sessions.find(
      s => s.user_id && s.phone_number && normalizePhoneNumber(s.phone_number) === cleanPhone
    );
    if (matchedSessionOwner?.user_id) {
      const u = getUserById(matchedSessionOwner.user_id);
      if (u) return u;
    }

    const matchedU = db.users.find(
      u => u.phone && normalizePhoneNumber(u.phone) === cleanPhone
    );
    if (matchedU) return matchedU;
  }

  return null;
}

function isOwnerActiveAndRegistered(owner: ReturnType<typeof getUserById>): boolean {
  return Boolean(owner && owner.is_active && owner.email_verified);
}

function scheduleAuthFolderBackup(sessionId: string, immediate = false) {
  if (!sessionId || !isMysqlConfigured()) return;
  const folder = safeSessionFolderPath(sessionId);
  if (!folder) return;

  const prev = authBackupTimers.get(sessionId);
  if (prev) clearTimeout(prev);

  const lastAt = lastAuthBackupAt.get(sessionId) || 0;
  const waitMs = immediate
    ? 2000
    : Math.max(AUTH_BACKUP_DEBOUNCE_MS, lastAt + AUTH_BACKUP_COOLDOWN_MS - Date.now());

  const timer = setTimeout(async () => {
    authBackupTimers.delete(sessionId);
    if (!isMysqlConfigured()) return;
    try {
      if (!hasRegisteredCredsOnDisk(sessionId)) return;
      const dirEntries = await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => null);
      if (!dirEntries) return;
      const files = dirEntries
        .filter(d => d.isFile() && d.name.endsWith('.json'))
        .map(d => d.name)
        .sort();
      const filesMap: Record<string, string> = {};
      const hash = crypto.createHash('sha256');
      for (const file of files) {
        const fp = path.join(folder, file);
        const content = await fs.promises.readFile(fp, 'utf-8');
        filesMap[file] = content;
        hash.update(file).update('\0').update(content).update('\0');
      }
      if (!filesMap['creds.json']) return;
      const digest = hash.digest('hex');
      if (lastAuthBackupHashes.get(sessionId) === digest) {
        return;
      }
      await saveBaileysAuthToMysql(sessionId, filesMap);
      lastAuthBackupHashes.set(sessionId, digest);
      lastAuthBackupAt.set(sessionId, Date.now());
    } catch {
      // Non-blocking backup
    }
  }, waitMs);
  timer.unref?.();

  authBackupTimers.set(sessionId, timer);
}

async function hydrateSessionAuthFolderFromMysql(sessionId: string): Promise<boolean> {
  const folder = safeSessionFolderPath(sessionId);
  if (!folder) return false;
  if (hasRegisteredCredsOnDisk(sessionId)) return true;

  try {
    const filesMap = await loadBaileysAuthFromMysql(sessionId);
    if (!filesMap || !filesMap['creds.json']) return false;

    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    }
    for (const [filename, content] of Object.entries(filesMap)) {
      const base = path.basename(filename);
      if (base === filename && base.endsWith('.json') && typeof content === 'string') {
        fs.writeFileSync(path.join(folder, base), content, { encoding: 'utf-8', mode: 0o600 });
      }
    }
    return hasRegisteredCredsOnDisk(sessionId);
  } catch {
    return false;
  }
}

// Clean session auth directory safely (with path traversal guard)
export function cleanSessionFolder(folderName: string) {
  const targetFolder = safeSessionFolderPath(folderName);
  if (!targetFolder) return;
  try {
    if (fs.existsSync(targetFolder)) {
      fs.rmSync(targetFolder, { recursive: true, force: true });
      console.log(`[Baileys] Auth folder deleted: ${targetFolder}`);
    }
  } catch (err) {
    console.error(`[Baileys] Error cleaning session folder ${folderName}:`, err);
  }
}

// Helper to attach Auto-Reply, Anti-Ban, Centang Biru, and Quota Deductions to Baileys socket
const commandState = new Map<string, { step: string; data?: any; updatedAt: number }>();
const COMMAND_STATE_TTL_MS = 15 * 60 * 1000;
const processedMessageIds = new Set<string>();

function cleanupExpiredCommandStates(now = Date.now()) {
  if (commandState.size === 0) return;
  for (const [key, entry] of commandState.entries()) {
    if (!entry.updatedAt || now - entry.updatedAt > COMMAND_STATE_TTL_MS) {
      commandState.delete(key);
    }
  }
}

function rememberProcessedMsgId(id?: string | null) {
  if (!id) return;
  processedMessageIds.add(id);
  if (processedMessageIds.size > 500) {
    const first = processedMessageIds.values().next().value;
    if (first) processedMessageIds.delete(first);
  }
}

// Parse /send and /broadcast arguments in flexible single or multi-recipient formats:
// 1) /send 08123456789 Halo kak
// 2) /broadcast 08123456789, 08198765432, 08571234567 Halo kak promo spesial!
// 3) Multiline phone list followed by shared message
// 4) Multiline where each line has <nomor> <pesan>
export function parseSendOrBroadcastTasks(rawArgs: string): Array<{ targetPhone: string; messageToSend: string }> {
  const cleanedInput = rawArgs.replace(/^\/(?:send|broadcast|kirim|kirimpesan)\b\s*/i, '').trim();
  if (!cleanedInput) return [];

  // Check if input has multiple lines where EACH line is a distinct "<phone> <message>" task
  const nonEmptyLines = cleanedInput
    .split(/\r?\n/)
    .map(l => l.replace(/^\/(?:send|broadcast|kirim|kirimpesan)\b\s*/i, '').trim())
    .filter(Boolean);

  if (nonEmptyLines.length > 1) {
    const perLineTasks: Array<{ targetPhone: string; messageToSend: string }> = [];
    let allLinesHaveOwnMsg = true;

    for (const line of nonEmptyLines) {
      const m = line.match(/^(\+?[0-9][0-9\-()]{7,15})\s*[:|\-]?\s+(.+)$/);
      if (m) {
        const digits = m[1].replace(/\D/g, '');
        const msg = m[2].trim();
        // Make sure the message part is not just another bare phone number
        const msgDigitsOnly = msg.replace(/[\s,;+\-()]/g, '');
        const looksLikePhoneList = /^[0-9]+$/.test(msgDigitsOnly) && msgDigitsOnly.length >= 8;
        if (digits.length >= 8 && digits.length <= 16 && msg && !looksLikePhoneList) {
          perLineTasks.push({ targetPhone: digits, messageToSend: msg });
        } else {
          allLinesHaveOwnMsg = false;
          break;
        }
      } else {
        allLinesHaveOwnMsg = false;
        break;
      }
    }

    if (allLinesHaveOwnMsg && perLineTasks.length > 1) {
      return perLineTasks;
    }
  }

  // 1. Key-value format: to=0812xxx,0819xxx text=Halo or to=0812xxx msg=Halo
  const kvMatch = cleanedInput.match(/^to=([^\s&]+)[,\s&]+(?:text|msg|pesan)=([\s\S]+)$/i);
  if (kvMatch) {
    const phones = kvMatch[1]
      .split(/[,;]+/)
      .map(p => p.replace(/\D/g, ''))
      .filter(p => p.length >= 8 && p.length <= 16);
    const msg = kvMatch[2].trim();
    if (phones.length > 0 && msg) {
      return Array.from(new Set(phones)).map(targetPhone => ({ targetPhone, messageToSend: msg }));
    }
  }

  // 2. Pipe format: 0812xxx, 0819xxx | Halo kak
  if (cleanedInput.includes('|')) {
    const pipeIdx = cleanedInput.indexOf('|');
    const phoneSection = cleanedInput.substring(0, pipeIdx);
    const msgPart = cleanedInput.substring(pipeIdx + 1).trim();
    const phones = phoneSection
      .split(/[\s,;]+/)
      .map(p => p.replace(/\D/g, ''))
      .filter(p => p.length >= 8 && p.length <= 16);
    if (phones.length > 0 && msgPart) {
      return Array.from(new Set(phones)).map(targetPhone => ({ targetPhone, messageToSend: msgPart }));
    }
  }

  // 3. Scan 1 or many leading phone numbers (separated by comma, semicolon, space, or newline) followed by shared message
  const phones: string[] = [];
  let pos = 0;
  while (pos < cleanedInput.length) {
    const wsMatch = cleanedInput.slice(pos).match(/^[\s,;]+/);
    if (wsMatch) pos += wsMatch[0].length;
    const tokMatch = cleanedInput.slice(pos).match(/^([^\s]+)/);
    if (!tokMatch) break;
    const token = tokMatch[1];
    const subParts = token.split(/[,;]+/).filter(Boolean);
    const isAllPhones =
      subParts.length > 0 &&
      subParts.every(sp => {
        const digits = sp.replace(/\D/g, '');
        return /^[\d+\-()]+$/.test(sp) && digits.length >= 8 && digits.length <= 16;
      });
    if (isAllPhones) {
      subParts.forEach(sp => phones.push(sp.replace(/\D/g, '')));
      pos += token.length;
    } else {
      break;
    }
  }

  if (phones.length > 0) {
    const msgPart = cleanedInput.slice(pos).replace(/^[\s:,\-|]+/, '').trim();
    if (msgPart) {
      return Array.from(new Set(phones)).map(targetPhone => ({ targetPhone, messageToSend: msgPart }));
    }
  }

  // 4. Phone number with spaces/dashes e.g. +62 812-3456-7890 Halo kak
  const flexMatch = cleanedInput.match(/^(\+?[0-9][0-9\-\s]{7,17}?)\s+([\s\S]+)$/);
  if (flexMatch) {
    const digits = flexMatch[1].replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 16 && flexMatch[2].trim()) {
      return [{ targetPhone: digits, messageToSend: flexMatch[2].trim() }];
    }
  }

  return [];
}

function parseSendCommandArgs(rawArgs: string): { targetPhone: string; messageToSend: string } {
  const tasks = parseSendOrBroadcastTasks(rawArgs);
  if (tasks.length > 0) {
    return tasks[0];
  }
  return { targetPhone: '', messageToSend: '' };
}

// Anti-Echo Loop Breaker: tracks texts sent recently by the bot to prevent self-reflection infinite loops
const recentBotOutgoingTexts = new Map<string, number>();

function recordBotOutgoing(text: string) {
  if (!text) return;
  const key = text.trim();
  recentBotOutgoingTexts.set(key, Date.now());
  if (recentBotOutgoingTexts.size > 300) {
    const now = Date.now();
    for (const [k, time] of recentBotOutgoingTexts.entries()) {
      if (now - time > 45000) recentBotOutgoingTexts.delete(k);
    }
  }
}

function isRecentBotOutgoing(text: string): boolean {
  if (!text) return false;
  const key = text.trim();
  const time = recentBotOutgoingTexts.get(key);
  if (time && (Date.now() - time < 45000)) {
    return true;
  }
  return false;
}

function attachSocketMessageListener(sock: any, sessionId: string, sessionData: SessionState) {
  sessionData.detachRawHandlers?.();
  sessionData.detachRawHandlers = attachMetaAiRawSocketHandlers(sock, sessionId);

  sock.ev.on('messages.update', (updates: any[]) => {
    try {
      handleMetaAiIncomingUpdate(sessionId, updates);
    } catch (err) {
      console.warn('[Baileys Meta AI Update Error]', err);
    }
  });

  sock.ev.on('messages.upsert', async (m: any) => {
    try {
      if (m.type !== 'notify' && m.type !== 'append') return;
      for (const msg of m.messages) {
        if (!msg.message) continue;

        const remoteJid = msg.key?.remoteJid || msg.message?.deviceSentMessage?.destinationJid;
        if (!remoteJid) continue;

        // Intercept Meta AI contact messages/replies (by JID, remoteJidAlt, or learned session LID) BEFORE other filters
        if (handleMetaAiIncomingUpsert(sessionId, msg)) {
          continue;
        }

        if (
          remoteJid.endsWith('@g.us') ||
          remoteJid === 'status@broadcast' ||
          remoteJid.endsWith('@broadcast') ||
          remoteJid.endsWith('@newsletter')
        ) {
          continue; // 1-on-1 chats only
        }

        const msgId = msg.key?.id;
        if (msgId && processedMessageIds.has(msgId)) continue;

        // Ignore old history sync on 'append' events (only allow fresh messages <= 45s old)
        if (m.type === 'append') {
          const rawTs = typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp
            : Number(msg.messageTimestamp?.low || msg.messageTimestamp || 0);
          if (rawTs > 0 && Math.floor(Date.now() / 1000) - rawTs > 45) {
            continue;
          }
        }

        // Unwrap nested WhatsApp Multi-Device containers (deviceSentMessage for self-chat, ephemeralMessage, viewOnce)
        const innerMsg =
          msg.message?.deviceSentMessage?.message ||
          msg.message?.ephemeralMessage?.message ||
          msg.message?.viewOnceMessage?.message ||
          msg.message?.viewOnceMessageV2?.message ||
          msg.message?.documentWithCaptionMessage?.message ||
          msg.message;

        const hasMediaAttachment = Boolean(
          innerMsg?.imageMessage ||
          innerMsg?.documentMessage ||
          msg.message?.imageMessage ||
          msg.message?.documentMessage
        );

        const rawMessageText = (
          innerMsg?.conversation ||
          innerMsg?.extendedTextMessage?.text ||
          innerMsg?.imageMessage?.caption ||
          innerMsg?.videoMessage?.caption ||
          innerMsg?.documentMessage?.caption ||
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          ''
        ).trim();

        if (!rawMessageText && (!hasMediaAttachment || msg.key.fromMe)) continue;

        const messageText = rawMessageText || '[Pelanggan mengirim lampiran gambar/dokumen bukti pembayaran]';

        // Anti-Echo loop breaker: ignore messages that match recent bot outgoing messages
        if (rawMessageText && isRecentBotOutgoing(rawMessageText)) {
          console.log(`[Baileys Anti-Echo] Discarding reflected message from bot's own output to prevent loop: "${rawMessageText.substring(0, 30)}..."`);
          continue;
        }

        cleanupExpiredCommandStates();
        const senderPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
        const senderName = msg.pushName || 'Pengguna WhatsApp';
        const trimmedMsg = messageText.trim();
        const stateKey = `${sessionId}:${remoteJid}`;
        const hasActiveDialog = commandState.has(stateKey) || commandState.has(senderPhone) || commandState.has(remoteJid);
        const isSlashCommand = trimmedMsg.startsWith('/');

        // When msg.key.fromMe is true (sent from the connected phone itself / self-chat):
        // ONLY allow if it is an explicit '/' command (like /send, /status, /help, /batal) OR an active /send step-2 reply.
        // Ignore all normal outgoing messages so personal notes & chats to customers never trigger auto-reply or loop!
        if (msg.key.fromMe && !isSlashCommand && !hasActiveDialog) {
          continue;
        }

        rememberProcessedMsgId(msgId);
        console.log(`[Baileys Incoming] Session=${sessionId} From=${senderPhone} (${senderName}) fromMe=${Boolean(msg.key.fromMe)} media=${hasMediaAttachment}: "${messageText}"`);

        const db = initDbFile();
        const cleanSender = senderPhone.replace(/\D/g, '');
        const cleanConnected = sessionData.phoneNumber ? sessionData.phoneNumber.replace(/\D/g, '') : '';
        const sockPhone = sock.user?.id ? sock.user.id.split('@')[0].split(':')[0].replace(/\D/g, '') : '';
        const sockLid = sock.user?.lid ? sock.user.lid.split('@')[0].split(':')[0].replace(/\D/g, '') : '';

        // Detect if sender is the bot's own connected number (self-chat / "Message Yourself")
        const isSelf = Boolean(
          msg.key.fromMe ||
          (cleanConnected && (cleanSender === cleanConnected || cleanSender.endsWith(cleanConnected) || cleanConnected.endsWith(cleanSender))) ||
          (sockPhone && (cleanSender === sockPhone || cleanSender.endsWith(sockPhone) || sockPhone.endsWith(cleanSender))) ||
          (sockLid && cleanSender === sockLid)
        );

        // Find user by registered phone, connected session phone, or session owner
        const matchedSessionBySender = db.sessions.find(s => {
          if (!s.phone_number) return false;
          const sp = s.phone_number.replace(/\D/g, '');
          return sp === cleanSender || (sp.length >= 8 && cleanSender.endsWith(sp.slice(-8))) || (cleanSender.length >= 8 && sp.endsWith(cleanSender.slice(-8)));
        });

        const user = db.users.find(u => {
          if (!u.phone) return false;
          const p = u.phone.replace(/\D/g, '');
          return p === cleanSender || (p.length >= 8 && cleanSender.endsWith(p.slice(-8))) || (cleanSender.length >= 8 && p.endsWith(cleanSender.slice(-8)));
        }) || (matchedSessionBySender?.user_id ? getUserById(matchedSessionBySender.user_id) : null)
           || (sessionData.userId ? getUserById(sessionData.userId) : null);

        const isOwner = Boolean(
          user && user.phone &&
          (user.phone.replace(/\D/g, '') === cleanSender || (cleanSender.length >= 8 && cleanSender.endsWith(user.phone.replace(/\D/g, '').slice(-8))))
        );
        const isAllowed = Boolean(
          user?.allowed_numbers &&
          user.allowed_numbers.some(n => n.replace(/\D/g, '') === cleanSender || cleanSender.endsWith(n.replace(/\D/g, '').slice(-8)))
        );

        // =========================================================================
        // REMOTE COMMAND BRIDGE & SELF-CHAT LOOP PREVENTION GUARD
        // Standardized to handle /send on BOTH System Number (including @lid) & Self-Chat
        // =========================================================================
        if (isSlashCommand || hasActiveDialog || isSelf || isOwner || isAllowed) {
          // Helper to clear dialog state across all possible keys for this sender
          const clearSenderDialogState = () => {
            commandState.delete(stateKey);
            commandState.delete(senderPhone);
            commandState.delete(remoteJid);
          };

          // Helper to select best active socket for sending outbound message
          const resolveOutboundSocket = () => {
            if (user) {
              const userSessions = Array.from(activeSessions.values()).filter(
                s => s.userId === user.id && s.status === 'connected' && s.socket
              );
              const primaryUserSession = userSessions.find(s => s.is_primary) || userSessions[0];
              if (primaryUserSession?.socket) return primaryUserSession.socket;
            }
            return sock;
          };

          // Helper to execute 1 or many send/broadcast tasks via WhatsApp command
          const executeSendOrBroadcastTasks = async (tasks: Array<{ targetPhone: string; messageToSend: string }>) => {
            const sockToUse = resolveOutboundSocket();

            if (tasks.length === 1) {
              const { targetPhone, messageToSend } = tasks[0];
              if (user) {
                const quota = deductUserDailyQuota(user.id);
                if (!quota.allowed) {
                  const quotaMsg = `❌ *Gagal Kirim:* ${quota.message || 'Batas kuota harian Anda telah habis.'}`;
                  recordBotOutgoing(quotaMsg);
                  await sock.sendMessage(remoteJid, { text: quotaMsg });
                  return;
                }
              }

              const cleanTarget = normalizePhoneNumber(targetPhone);
              const targetJid = `${cleanTarget}@s.whatsapp.net`;
              try {
                recordBotOutgoing(messageToSend);
                await sockToUse.sendMessage(targetJid, { text: messageToSend });

                addMessageLog({
                  wam_id: `cmd_out_${Date.now()}`,
                  session_id: sessionId,
                  user_id: user?.id || sessionData.userId,
                  sender_phone: cleanTarget,
                  sender_name: `Tujuan (${cleanTarget})`,
                  message_body: messageToSend,
                  direction: 'outgoing',
                  status: 'Sukses',
                  reply_body: 'Dikirim via Remote WhatsApp Command (/send)'
                });

                const successReply =
                  `✅ *Pesan Berhasil Terkirim!*\n\n` +
                  `• Nomor Tujuan: *${cleanTarget}*\n` +
                  `• Isi Pesan: "${messageToSend}"\n` +
                  `• Via Gateway: *${sessionData.phoneNumber || sockPhone || 'Japriin'}*`;
                recordBotOutgoing(successReply);
                await sock.sendMessage(remoteJid, { text: successReply });
              } catch (sendErr: any) {
                const errMsg = `❌ *Gagal mengirim pesan ke ${cleanTarget}:* ${sendErr?.message || 'Error koneksi gateway'}`;
                recordBotOutgoing(errMsg);
                await sock.sendMessage(remoteJid, { text: errMsg });
              }
              return;
            }

            // Multi-recipient broadcast execution (many messages)
            const startNotice =
              `⏳ *Memproses Broadcast ke ${tasks.length} Nomor...*\n` +
              `Mohon tunggu, pesan sedang dikirim bertahap dengan proteksi Anti-Ban Guard.`;
            recordBotOutgoing(startNotice);
            await sock.sendMessage(remoteJid, { text: startNotice });

            let successCount = 0;
            let failedCount = 0;
            const successPhones: string[] = [];

            for (let i = 0; i < tasks.length; i++) {
              const { targetPhone, messageToSend } = tasks[i];
              const cleanTarget = normalizePhoneNumber(targetPhone);
              if (!cleanTarget || cleanTarget.length < 8) {
                failedCount++;
                continue;
              }

              if (user) {
                const quota = deductUserDailyQuota(user.id);
                if (!quota.allowed) {
                  failedCount++;
                  continue;
                }
              }

              const targetJid = `${cleanTarget}@s.whatsapp.net`;
              try {
                recordBotOutgoing(messageToSend);
                await Promise.race([
                  sockToUse.sendMessage(targetJid, { text: messageToSend }),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout pengiriman WA')), 15000))
                ]);

                successCount++;
                successPhones.push(cleanTarget);
                addMessageLog({
                  wam_id: `bc_cmd_${Date.now()}_${i}`,
                  session_id: sessionId,
                  user_id: user?.id || sessionData.userId,
                  sender_phone: cleanTarget,
                  sender_name: `Broadcast (${cleanTarget})`,
                  message_body: messageToSend,
                  direction: 'outgoing',
                  status: 'Sukses',
                  reply_body: 'Dikirim via Broadcast WhatsApp (/broadcast)'
                });
              } catch (err: any) {
                failedCount++;
                addMessageLog({
                  wam_id: `bc_fail_${Date.now()}_${i}`,
                  session_id: sessionId,
                  user_id: user?.id || sessionData.userId,
                  sender_phone: cleanTarget,
                  sender_name: `Broadcast (${cleanTarget})`,
                  message_body: messageToSend,
                  direction: 'outgoing',
                  status: 'Gagal',
                  error_detail: err?.message || 'Gagal kirim broadcast'
                });
              }

              if (i < tasks.length - 1) {
                await delay(1000 + Math.floor(Math.random() * 800));
              }
            }

            addBroadcastHistory({
              user_id: user?.id || sessionData.userId,
              session_id: sessionId,
              recipients_count: tasks.length,
              message: tasks[0]?.messageToSend || 'Broadcast Multi-Pesan',
              status: failedCount === tasks.length ? 'failed' : 'completed',
              success_count: successCount,
              failed_count: failedCount
            });

            const summaryReply =
              `✅ *Broadcast Selesai Diproses!*\n\n` +
              `• Total Tujuan: *${tasks.length} Nomor*\n` +
              `• Berhasil Terkirim: *${successCount} Nomor*\n` +
              `• Gagal: *${failedCount} Nomor*\n` +
              (successPhones.length > 0
                ? `• Penerima: *${successPhones.slice(0, 6).join(', ')}${successPhones.length > 6 ? ` (+${successPhones.length - 6} lainnya)` : ''}*\n`
                : '') +
              `• Via Gateway: *${sessionData.phoneNumber || sockPhone || 'Japriin'}*\n` +
              `• Log Retensi: *Otomatis dihapus setelah 7 hari*`;
            recordBotOutgoing(summaryReply);
            await sock.sendMessage(remoteJid, { text: summaryReply });
          };

          // If the message is a command starting with '/'
          if (isSlashCommand) {
            const parts = trimmedMsg.split(/\s+/);
            const cmd = parts[0].toLowerCase();

            // Command: /batal or /cancel
            if (cmd === '/batal' || cmd === '/cancel') {
              clearSenderDialogState();
              const cancelReply = `✓ *Perintah interaktif telah dibatalkan.*`;
              recordBotOutgoing(cancelReply);
              await sock.sendMessage(remoteJid, { text: cancelReply });
              continue;
            }

            // Command: /status or /saldo or /kuota or /cekkuota or /statusbot
            if (cmd === '/status' || cmd === '/saldo' || cmd === '/kuota' || cmd === '/cekkuota' || cmd === '/statusbot') {
              const u = user || (sessionData.userId ? getUserById(sessionData.userId) : null);
              const plan = db.plans.find(p => p.id === u?.plan_id) || db.plans[0];
              const usedToday = u?.daily_messages_sent || 0;
              const remainingToday = Math.max(0, (plan?.daily_msg_limit || 100) - usedToday);
              const statusReply =
                `📊 *Status Japriin Gateway*\n\n` +
                `• Akun: *${u?.name || 'Operator'}* (@${u?.username || 'user'})\n` +
                `• Paket: *${plan?.name || 'Pro'}*\n` +
                `• Nomor Gateway: *${sessionData.phoneNumber || sockPhone || 'Terhubung'}*\n` +
                `• Sisa Kuota Hari Ini: *${remainingToday} / ${plan?.daily_msg_limit || 100} pesan*\n` +
                `• Status Gateway: *TERHUBUNG (Anti-Ban Guard Aktif)*\n\n` +
                `_Ketik */send* untuk mengirim pesan ke nomor tujuan._`;
              recordBotOutgoing(statusReply);
              await sock.sendMessage(remoteJid, { text: statusReply });
              continue;
            }

            // Command: /help or /bantuan or /menu
            if (cmd === '/help' || cmd === '/bantuan' || cmd === '/menu') {
              const helpReply =
                `🤖 *Panduan Japriin Remote Command Bridge*\n\n` +
                `Anda dapat mengirim pesan dari Nomor Sistem maupun Nomor Sendiri dengan perintah berikut:\n\n` +
                `1️⃣ */send*\n` +
                `   Membuka template interaktif kirim pesan.\n\n` +
                `2️⃣ */send <nomor_tujuan> <isi_pesan>*\n` +
                `   Kirim pesan langsung dalam 1 langkah.\n` +
                `   _Contoh: /send 08123456789 Halo kak, pesanan sudah dikirim._\n\n` +
                `3️⃣ */status* atau */kuota*\n` +
                `   Cek sisa kuota harian & status koneksi bot.\n\n` +
                `4️⃣ */batal*\n` +
                `   Batalkan dialog kirim pesan yang sedang aktif.\n\n` +
                `💡 _Standar Anti-Loop: Chat biasa tanpa awalan / ke nomor sendiri otomatis diabaikan agar tidak memicu balasan berulang (looping)._`;
              recordBotOutgoing(helpReply);
              await sock.sendMessage(remoteJid, { text: helpReply });
              continue;
            }

            // Command: /send or /broadcast or /kirim or /kirimpesan
            if (cmd === '/send' || cmd === '/broadcast' || cmd === '/kirim' || cmd === '/kirimpesan') {
              const fullArgs = trimmedMsg.substring(cmd.length).trim();
              const tasks = parseSendOrBroadcastTasks(fullArgs);

              // Direct execution if 1 or more valid phone+message tasks are present
              if (tasks.length > 0) {
                clearSenderDialogState();
                await executeSendOrBroadcastTasks(tasks);
                continue;
              }

              // Prompt template if /send or /broadcast was typed alone (or without full args)
              const nowTs = Date.now();
              commandState.set(stateKey, { step: 'awaiting_direct_target', updatedAt: nowTs });
              commandState.set(senderPhone, { step: 'awaiting_direct_target', updatedAt: nowTs });
              const promptMsg =
                `📱 *Template Kirim Pesan & Broadcast (Japriin Bridge)*\n\n` +
                `Silakan balas pesan ini dengan salah satu format berikut:\n\n` +
                `1️⃣ *Kirim ke 1 Nomor:*\n` +
                `*08123456789 Halo kak, pesanan Anda sudah siap dikirim.*\n\n` +
                `2️⃣ *Broadcast ke Banyak Nomor (1 Pesan Sama):*\n` +
                `*08123456789, 08198765432, 08571234567 Halo kak, promo spesial hari ini!*\n` +
                `_(Nomor juga bisa disusun per baris baru lalu diikuti isi pesan di bawahnya)_\n\n` +
                `3️⃣ *Broadcast Banyak Pesan Berbeda (Per Baris):*\n` +
                `*08123456789 Halo kak Budi, pesanan siap*\n` +
                `*08198765432 Halo kak Ani, pesanan dikirim*\n\n` +
                `_Ketik */batal* untuk membatalkan pengiriman._`;
              recordBotOutgoing(promptMsg);
              await sock.sendMessage(remoteJid, { text: promptMsg });
              continue;
            }

            // Unknown '/' command: give helpful menu instead of falling through to offline auto-reply
            const unknownCmdReply =
              `ℹ️ Perintah *${cmd}* tidak dikenali.\n\n` +
              `Gunakan perintah standar berikut:\n` +
              `• */send* — Template kirim pesan / broadcast\n` +
              `• */send <nomor> <pesan>* — Kirim pesan langsung\n` +
              `• */broadcast <nomor1>,<nomor2> <pesan>* — Broadcast banyak nomor\n` +
              `• */status* — Cek kuota & status gateway\n` +
              `• */help* — Panduan lengkap`;
            recordBotOutgoing(unknownCmdReply);
            await sock.sendMessage(remoteJid, { text: unknownCmdReply });
            continue;
          }

          // Check if waiting for target and message in active dialog (/send or /broadcast step 2)
          const activeState = commandState.get(stateKey) || commandState.get(senderPhone) || commandState.get(remoteJid);
          if (activeState && activeState.step === 'awaiting_direct_target') {
            const tasks = parseSendOrBroadcastTasks(trimmedMsg);

            if (tasks.length > 0) {
              clearSenderDialogState();
              await executeSendOrBroadcastTasks(tasks);
              continue;
            } else {
              const helpFormat =
                `⚠️ *Format Pengiriman Belum Sesuai*\n\n` +
                `Silakan kirim dengan format:\n` +
                `👉 *<nomor_tujuan> <isi_pesan>*\n` +
                `👉 *<nomor1>, <nomor2>, <nomor3> <isi_pesan>*\n\n` +
                `Contoh:\n` +
                `*08123456789 Halo Kak, pesanan sudah dikirim*\n\n` +
                `_Atau ketik */batal* untuk keluar dari mode kirim pesan._`;
              recordBotOutgoing(helpFormat);
              await sock.sendMessage(remoteJid, { text: helpFormat });
              continue;
            }
          }

          // =========================================================================
          // CRITICAL STANDAR INDUSTRI:
          // Pesan dari nomor sendiri/owner yang BUKAN berawalan '/' dan BUKAN dalam dialog:
          // ABAIKAN SECARA DIAM (SILENT / NO-OP) agar tidak memicu Auto-Reply / Gemini AI / Pesan Offline.
          // Ini 100% mencegah looping forever pada chat nomor sendiri!
          // =========================================================================
          console.log(`[Baileys Self-Chat Ignored] Pesan dari nomor sendiri/owner (${senderPhone}) bukan perintah '/'. Dilewati (tanpa auto-reply).`);
          continue;
        }


        // 2. Get session owner information for multi-user isolation & quota checking
        let dbSession = getSessionById(sessionId);
        if (!dbSession && sessionData.phoneNumber) {
          const cleanConnected = sessionData.phoneNumber.replace(/\D/g, '');
          dbSession = db.sessions.find(s => s.phone_number && s.phone_number.replace(/\D/g, '') === cleanConnected) || null;
        }

        let sessionUserId = dbSession?.user_id || sessionData.userId;
        if (!sessionUserId && sessionData.phoneNumber) {
          const cleanPhone = sessionData.phoneNumber.replace(/\D/g, '');
          const matchedUser = db.users.find(u => u.phone && normalizePhoneNumber(u.phone) === cleanPhone);
          if (matchedUser) sessionUserId = matchedUser.id;
        }
        if (!sessionUserId) {
          sessionUserId = extractUserIdFromSessionId(sessionId, db.users);
        }

        if (dbSession && sessionUserId && !dbSession.user_id) {
          dbSession.user_id = sessionUserId;
          updateSession(dbSession.id, { user_id: sessionUserId });
        }

        const sessionUser = sessionUserId ? getUserById(sessionUserId) : null;
        if (!isOwnerActiveAndRegistered(sessionUser)) {
          console.warn(`[Baileys Security] Session ${sessionId} has no active registered user. Purging session.`);
          purgeBaileysSessionCompletely(sessionId, sessionData.phoneNumber || undefined).catch(() => {});
          continue;
        }

        const autoReplyStatus = getUserAutoReplyStatus(sessionUser);
        if (!autoReplyStatus.allowed) {
          addMessageLog({
            wam_id: msg.key.id || `baileys_in_${Date.now()}`,
            user_id: sessionUser!.id,
            session_id: sessionId,
            sender_phone: senderPhone,
            sender_name: senderName,
            message_body: messageText,
            direction: 'incoming',
            status: 'Diterima',
            reply_body: autoReplyStatus.reason || 'Respon pesan otomatis sedang nonaktif.',
            ai_generated: false
          });
          // JANGAN hapus kredensial sesi ketika kuota respon otomatis user gratis habis:
          // WA Blast & REST API v1 tetap harus bisa berjalan, sementara socket idle akan diparkir oleh watchdog untuk hemat RAM.
          continue;
        }

        // Check active rules isolated per user and anti-ban configuration
        const rules = getAutoReplyRules(sessionUserId).filter(r => r.is_active);
        const antiBan = getAntiBanSettings();

        // Match keyword rule
        let matchedRule = null;
        for (const rule of rules) {
          const kw = rule.keyword.toLowerCase().trim();
          const text = messageText.toLowerCase().trim();
          if (rule.match_type === 'exact' && text === kw) {
            matchedRule = rule;
            break;
          } else if (rule.match_type === 'startsWith' && text.startsWith(kw)) {
            matchedRule = rule;
            break;
          } else if (rule.match_type === 'contains' && text.includes(kw)) {
            matchedRule = rule;
            break;
          }
        }

        let replyText = '';
        let isAi = false;
        let sendQrisImage = false;
        let qrisImageUrl: string | undefined;
        let qrisPublicUrl: string | undefined;
        let orderPaidVerified = false;
        let currentOrderFlow: ReturnType<typeof prepareOrderFlowForIncomingMessage> | null = null;
        let currentActiveCatalog: ReturnType<typeof getActiveCatalogForAi> | null = null;

        const resolvedOwnerId = sessionUser?.id || sessionUserId;
        const scopeId = resolvedOwnerId || sessionId;

        if (matchedRule) {
          replyText = matchedRule.response_text
            .replace(/\{nama\}/gi, senderName)
            .replace(/\{pesan\}/gi, messageText);
          recordCustomerTurn(scopeId, senderPhone, 'customer', messageText);
        } else {
          const sysConfig = getSystemConfig();
          const effectiveAi = resolveEffectiveSessionAiSettings({
            user: sessionUser,
            session: dbSession,
            sysConfig
          });
          const userPersonalPrompt = effectiveAi.systemPrompt;
          const canUseAi = effectiveAi.aiEnabled;

          const activeCatalog = getActiveCatalogForAi(resolvedOwnerId);
          currentActiveCatalog = activeCatalog;
          const orderFlow = prepareOrderFlowForIncomingMessage({
            scopeId,
            senderPhone,
            messageText,
            catalog: activeCatalog,
            hasMediaAttachment
          });
          currentOrderFlow = orderFlow;
          const priorHistory = orderFlow.context.history.slice(-6).map(h => ({ role: h.role, text: h.text }));
          recordCustomerTurn(scopeId, senderPhone, 'customer', messageText);

          if (orderFlow.directReply) {
            replyText = orderFlow.directReply.text;
            sendQrisImage = orderFlow.directReply.sendQrisImage;
            qrisImageUrl = orderFlow.directReply.qrisImageUrl;
            qrisPublicUrl = orderFlow.directReply.qrisPublicUrl;
            isAi = false;
            console.log(
              `[Baileys Order System] Fast-path "${orderFlow.directReply.reason}" untuk ${orderFlow.context.customerCode} (QRIS=${sendQrisImage})`
            );
          } else {
            const aiQuotaCheck: ReturnType<typeof canUseAiQuota> = sessionUser
              ? canUseAiQuota(sessionUser.id)
              : {
                  allowed: true,
                  remainingDaily: 999999,
                  dailyLimit: 999999,
                  remainingMonthly: 999999,
                  monthlyLimit: 999999
                };

            if (canUseAi && aiQuotaCheck.allowed) {
              try {
                console.log(
                  `[Baileys Meta AI] Forwarding ${orderFlow.context.customerCode} via session ${sessionId} (catalog=${activeCatalog.enabled ? `${activeCatalog.products.length} produk` : 'off'})...`
                );
                const aiRes = await askMetaAiViaBaileys({
                  userId: resolvedOwnerId,
                  sessionId,
                  senderPhone,
                  senderName,
                  messageBody: messageText,
                  customSystemPrompt: userPersonalPrompt,
                  autoReplyRules: rules,
                  catalogShopName: activeCatalog.shopName,
                  catalogProducts: activeCatalog.enabled ? activeCatalog.products : undefined,
                  customerCode: orderFlow.context.customerCode,
                  customerHistory: priorHistory,
                  orderSummary: orderFlow.orderSummaryForPrompt || undefined,
                  paymentSummary: orderFlow.paymentSummaryForPrompt || undefined
                });
                if (aiRes.usedAi && aiRes.replyText) {
                  const directive = parseAndHandleAiPaymentDirectives(aiRes.replyText, activeCatalog, {
                    customerContext: orderFlow.context,
                    isPaymentSubmission: orderFlow.isPaymentSubmission
                  });
                  replyText = directive.cleanText;
                  sendQrisImage = directive.sendQrisImage;
                  qrisImageUrl = directive.qrisImageUrl;
                  qrisPublicUrl = directive.qrisPublicUrl;
                  orderPaidVerified = directive.orderPaidVerified;
                  isAi = true;
                  if (sessionUser && sessionData.phoneNumber && !isPhoneMetaAiVerifiedForUser(sessionUser, sessionData.phoneNumber)) {
                    markUserMetaAiVerified(sessionUser.id, sessionData.phoneNumber);
                  }
                } else if (aiRes.errorReason) {
                  console.log(`[Baileys Meta AI Fallback] ${aiRes.errorReason}`);
                  if (
                    sessionUser &&
                    sessionUser.role !== 'admin' &&
                    sessionData.phoneNumber &&
                    !isPhoneMetaAiVerifiedForUser(sessionUser, sessionData.phoneNumber) &&
                    /bot_unavailable_fanout|error 463|error 488/i.test(aiRes.errorReason)
                  ) {
                    if (dbSession) {
                      updateSession(dbSession.id, { ai_enabled: false });
                    }
                    const hasAnyVerifiedPhone =
                      Array.isArray(sessionUser.meta_ai_verified_phones) &&
                      sessionUser.meta_ai_verified_phones.length > 0;
                    if (!hasAnyVerifiedPhone) {
                      updateUser(sessionUser.id, { ai_enabled: false });
                    }
                  }
                }
              } catch (aiErr) {
                console.error('[Baileys Meta AI Reply Error]', aiErr);
              }
            } else if (canUseAi && !aiQuotaCheck.allowed) {
              console.log(`[Baileys Meta AI Quota] User ${sessionUser?.username} kuota AI habis (${aiQuotaCheck.message}). Beralih ke pesan offline.`);
            }

            if (!replyText && orderFlow.context.cart.length > 0) {
              const deterministicOrderReply = buildDeterministicOrderFallbackReply({
                context: orderFlow.context,
                catalog: activeCatalog,
                messageText,
                isPaymentSubmission: orderFlow.isPaymentSubmission
              });
              if (deterministicOrderReply) {
                replyText = deterministicOrderReply;
              }
            }

            // If still no replyText (AI disabled, quota exhausted, or Meta AI unavailable):
            // Send user's default CS reply fallback only when explicitly enabled
            if (!replyText) {
              const isCsEnabled = sessionUser
                ? (sessionUser.role === 'admin' ? sessionUser.default_cs_reply_enabled !== false : sessionUser.default_cs_reply_enabled === true)
                : true;
              if (isCsEnabled) {
                const customOfflineMsg = sessionUser?.default_cs_reply_text || sessionUser?.custom_offline_message || sysConfig.ai_config.offline_fallback_message ||
                  'Halo *{nama}*, terima kasih telah menghubungi kami. Tim Customer Service kami akan segera membalas pesan Anda sesegera mungkin.';
                replyText = customOfflineMsg
                  .replace(/\{nama\}/gi, senderName)
                  .replace(/\{pesan\}/gi, messageText);
              }
            }
          }
        }

        if (replyText) {
          // Tandai centang biru tepat saat bot siap mulai mengetik & membalas (jika read_receipt_simulation aktif)
          if (!msg.key.fromMe && antiBan.read_receipt_simulation) {
            try {
              const readJitter = 120 + crypto.randomInt(0, 220);
              await delay(readJitter);
              await sock.readMessages([msg.key]);
            } catch (readErr) {
              console.warn('[Baileys Read Receipt error]', readErr);
            }
          }

          // Anti-Ban Simulation & Length-Scaled Random Typing Delay
          if (antiBan.enabled) {
            const minS = Math.max(1, antiBan.min_delay_seconds || 1);
            const maxS = Math.max(minS, antiBan.max_delay_seconds || 4);
            const baseMs = minS * 1000;
            const spanMs = Math.max(500, (maxS - minS) * 1000);
            const lengthFactor = Math.min(1, replyText.length / 180);
            const jitterMs = crypto.randomInt(0, Math.max(250, Math.floor(spanMs * 0.45)));
            const randomDelayMs = Math.min(maxS * 1000, Math.round(baseMs + spanMs * 0.55 * lengthFactor + jitterMs));

            console.log(`[Baileys Anti-Ban] Typing simulation & random delay (${(randomDelayMs / 1000).toFixed(1)}s) for ${senderPhone}...`);

            if (antiBan.typing_simulation) {
              await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
            }

            await new Promise(res => setTimeout(res, randomDelayMs));

            if (antiBan.typing_simulation) {
              await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
            }
          }

          // Send auto-reply or direct QRIS image without delegating QRIS image to Meta AI
          recordBotOutgoing(replyText);
          let sentQrisSuccessfully = false;
          if (sendQrisImage && (qrisImageUrl || qrisPublicUrl)) {
            const localQrisBuf = resolveLocalCatalogImageBuffer(qrisImageUrl || qrisPublicUrl);
            const imageSource: any = localQrisBuf
              ? localQrisBuf
              : (qrisPublicUrl && /^https?:\/\//i.test(qrisPublicUrl) ? { url: qrisPublicUrl } : null);
            if (imageSource) {
              try {
                await sock.sendMessage(remoteJid, {
                  image: imageSource,
                  caption: replyText
                });
                sentQrisSuccessfully = true;
                console.log(`[Baileys System QRIS Sent] To ${senderPhone} (${qrisImageUrl})`);
              } catch (qrisErr) {
                console.warn('[Baileys QRIS Send Fallback to Text]', qrisErr);
              }
            }
          }

          if (!sentQrisSuccessfully) {
            await sock.sendMessage(remoteJid, { text: replyText });
            console.log(`[Baileys Auto-Reply Sent ${isAi ? '(AI)' : ''}] To ${senderPhone}: "${replyText}"`);
          }

          recordCustomerTurn(scopeId, senderPhone, 'assistant', replyText);

          // DEDUCT USER QUOTAS (DAILY & MONTHLY) IMMEDIATELY
          if (sessionUser) {
            const msgDeduct = deductUserDailyQuota(sessionUser.id);
            if (isAi) {
              const aiDeduct = deductUserAiQuota(sessionUser.id);
              console.log(`[Baileys Quota Deducted] AI User ${sessionUser.username}: Daily AI=${aiDeduct.remainingDaily}/${aiDeduct.dailyLimit}, Monthly AI=${aiDeduct.remainingMonthly}/${aiDeduct.monthlyLimit}`);
            } else {
              console.log(`[Baileys Quota Deducted] Msg User ${sessionUser.username}: Daily Msg=${msgDeduct.remaining}/${msgDeduct.dailyLimit}`);
            }
          }
        }

        // Trigger Owner/Admin Order List Notification via Superadmin WA when AI verifies order paid
        if (orderPaidVerified && currentOrderFlow) {
          const paidSnapshot = completeAndConsumeVerifiedPaidOrder(scopeId, senderPhone);
          if (paidSnapshot) {
            const ownerTargetPhone =
              resolveOrderNotificationRecipientPhone(resolvedOwnerId) ||
              currentActiveCatalog?.orderNotifyPhone ||
              '';
            if (ownerTargetPhone) {
              const ownerNotifyMsg = formatOwnerOrderNotificationMessage({
                snapshot: paidSnapshot,
                shopName: currentActiveCatalog?.shopName,
                customerPhone: senderPhone,
                customerName: senderName,
                customerNote: rawMessageText,
                hasMediaAttachment
              });
              await sendOrQueueViaSuperadminWa({
                recipientPhone: ownerTargetPhone,
                message: ownerNotifyMsg,
                category: 'order_notification',
                ownerUserId: resolvedOwnerId,
                invoiceNumber: paidSnapshot.invoiceNumber
              }).catch(err => console.warn('[Order Owner Notify Error]', err?.message || err));
            } else {
              console.warn(`[Order Owner Notify] Nomor tujuan pemilik usaha belum tersedia untuk user ${resolvedOwnerId} (Invoice ${paidSnapshot.invoiceNumber}).`);
            }
          }
        }

        // Add to database message logs with isolated user_id & session_id
        addMessageLog({
          wam_id: msg.key.id || `baileys_in_${Date.now()}`,
          session_id: dbSession?.id || sessionId,
          user_id: sessionUserId,
          sender_phone: senderPhone,
          sender_name: senderName,
          message_body: messageText,
          direction: 'incoming',
          status: replyText ? 'Sukses' : 'Diterima',
          reply_body: replyText || undefined,
          ai_generated: isAi
        });
      }
    } catch (err) {
      console.error('[Baileys Message Listener Error]', err);
    }
  });
}

// Start or get active Baileys socket for QR Code or persistent session
export async function getOrStartBaileysSession(
  rawSessionId: string = 'session_primary_default',
  phoneNumber?: string,
  userId?: string
): Promise<SessionState> {
  const sessionId = sanitizeSessionId(rawSessionId);
  const existing = activeSessions.get(sessionId);
  if (existing && existing.status === 'connected' && isSocketTrulyOpen(existing.socket)) {
    if (userId && !existing.userId) existing.userId = userId;
    existing.retryCount = 0;
    return existing;
  }

  // If currently connecting within the last 30 seconds and socket is still alive, do not kill the handshake
  if (
    existing &&
    existing.status === 'connecting' &&
    existing.socket &&
    Date.now() - existing.lastUpdated < 30000
  ) {
    if (userId && !existing.userId) existing.userId = userId;
    return existing;
  }

  // Prevent concurrent duplicate socket creation on the same sessionId
  const inFlight = sessionStartLocks.get(sessionId);
  if (inFlight) {
    return inFlight;
  }

  const initPromise = (async (): Promise<SessionState> => {
    try {
      clearSessionTimers(sessionId);

      const current = activeSessions.get(sessionId);
      const prevRetries = current?.retryCount || 0;
      if (current && current.socket) {
        try {
          current.socket.ev?.removeAllListeners?.('connection.update');
          current.socket.ev?.removeAllListeners?.('creds.update');
          current.socket.ev?.removeAllListeners?.('messages.upsert');
          current.socket.ev?.removeAllListeners?.('messages.update');
          current.socket.end(undefined);
          current.socket.ws?.removeAllListeners?.();
        } catch {
          // Ignore
        }
        current.detachRawHandlers?.();
        clearMetaAiSession(sessionId);
        activeSessions.delete(sessionId);
      }

      const sessionFolder = safeSessionFolderPath(sessionId);
      if (!sessionFolder) {
        throw new Error('Folder sesi WhatsApp tidak valid.');
      }
      if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true, mode: 0o700 });
      }

      // Restore credentials from Online MySQL if container restarted and local disk is empty
      if (!hasRegisteredCredsOnDisk(sessionId)) {
        await hydrateSessionAuthFolderFromMysql(sessionId);
      } else {
        scheduleAuthFolderBackup(sessionId);
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
      const version = await resolveBaileysVersion();

      const sock = makeWASocket(buildBaileysSocketConfig(version, BAILEYS_SILENT_LOGGER, state));

      const sessionData: SessionState = {
        sessionId,
        userId,
        socket: sock,
        qrCodeUrl: null,
        pairingCode: null,
        status: 'connecting',
        phoneNumber: phoneNumber || null,
        lastUpdated: Date.now(),
        handshakeStartedAt: current?.handshakeStartedAt || Date.now(),
        retryCount: prevRetries
      };

      activeSessions.set(sessionId, sessionData);

      // Safe sequential credential saving queue + automatic MySQL backup
      let credsSaveQueue: Promise<void> = Promise.resolve();
      sock.ev.on('creds.update', () => {
        credsSaveQueue = credsSaveQueue.then(async () => {
          try {
            await saveCreds();
            scheduleAuthFolderBackup(sessionId);
          } catch (saveErr) {
            console.warn('[Baileys] Error saving creds:', saveErr);
          }
        });
      });

      sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            const qrUrl = await QRCode.toDataURL(qr, { margin: 2, width: 300 });
            sessionData.qrCodeUrl = qrUrl;
            sessionData.lastUpdated = Date.now();
            activeSessions.set(sessionId, sessionData);
          } catch (e) {
            console.error('[Baileys] Error generating QR data URL:', e);
          }
        }

        if (connection === 'open') {
          const rawSockUser = sock.user?.id ? sock.user.id.split('@')[0].split(':')[0] : '';
          const connectedUser = normalizePhoneNumber(rawSockUser || phoneNumber || sessionData.phoneNumber || '');
          if (!connectedUser || connectedUser.length < 8) {
            console.warn(`[Baileys] Connected session ${sessionId} missing valid phone identity; purging.`);
            await purgeBaileysSessionCompletely(sessionId);
            return;
          }

          const db = initDbFile();
          const owner = resolveActiveVerifiedOwner(sessionId, sessionData.userId, connectedUser);
          if (!isOwnerActiveAndRegistered(owner)) {
            console.warn(`[Baileys Security] Connected session ${sessionId} (${connectedUser}) has no active registered user in app. Purging immediately.`);
            await purgeBaileysSessionCompletely(sessionId, connectedUser);
            return;
          }

          console.log(`[Baileys] WhatsApp Connected successfully for session: ${sessionId} (Owner: ${owner!.username})`);
          sessionData.status = 'connected';
          sessionData.phoneNumber = connectedUser;
          sessionData.qrCodeUrl = null;
          sessionData.pairingCode = null;
          sessionData.lastUpdated = Date.now();
          sessionData.retryCount = 0;
          sessionData.disconnectedSince = undefined;
          sessionData.userId = owner!.id;
          sessionData.is_primary = Boolean(getSessionById(sessionId)?.is_primary);
          clearSessionExpiryNotificationCooldown(sessionId, owner!.id, connectedUser);
          activeSessions.set(sessionId, sessionData);
          scheduleAuthFolderBackup(sessionId, true);

          const existingDb =
            getSessionById(sessionId) ||
            db.sessions.find(
              s =>
                s.user_id === owner!.id &&
                s.phone_number &&
                normalizePhoneNumber(s.phone_number) === connectedUser
            );
          const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          if (existingDb) {
            updateSession(existingDb.id, {
              id: sessionId,
              status: 'connected',
              phone_number: connectedUser,
              user_id: owner!.id,
              connected_at: existingDb.connected_at || new Date().toISOString(),
              expires_at: existingDb.expires_at || expiryDate
            });
          } else {
              addSession({
                id: sessionId,
                session_name: `WA - ${connectedUser}`,
                phone_number: connectedUser,
                auth_method: 'qr_code',
                status: 'connected',
                user_id: owner!.id,
                is_primary: true,
                expires_at: expiryDate
              });
            }

          if (
            owner!.role !== 'admin' &&
            owner!.ai_enabled === true &&
            Array.isArray(owner!.meta_ai_verified_phones) &&
            owner!.meta_ai_verified_phones.length > 0 &&
            !isPhoneMetaAiVerifiedForUser(owner, connectedUser)
          ) {
            updateUser(owner!.id, { ai_enabled: false });
          }

          if (owner!.role === 'admin') {
            setTimeout(() => {
              drainSuperadminWaQueue('admin_session_open').catch(() => {});
              processPendingSessionExpiryAlerts('admin_session_open').catch(() => {});
            }, 2500);
          }
        } else if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const isFatal = isFatalDisconnectCode(statusCode);
          const isRegistered = hasRegisteredCredsOnDisk(sessionId);

          // Ignore close events from a superseded socket if a newer socket is already in activeSessions
          const latestSession = activeSessions.get(sessionId);
          if (latestSession && latestSession.socket && latestSession.socket !== sock) {
            return;
          }

          console.log(
            `[Baileys] Connection closed for ${sessionId}. Status: ${statusCode}. Registered: ${isRegistered}. Fatal: ${isFatal}`
          );

          try {
            sessionData.detachRawHandlers?.();
            sock.ev?.removeAllListeners?.('connection.update');
            sock.ev?.removeAllListeners?.('creds.update');
            sock.ev?.removeAllListeners?.('messages.upsert');
            sock.ev?.removeAllListeners?.('messages.update');
            sock.ws?.removeAllListeners?.();
          } catch {
            // Ignore listener cleanup errors on closed socket
          }

          sessionData.qrCodeUrl = null;
          sessionData.pairingCode = null;
          sessionData.socket = null;

          if (isFatal) {
            console.warn(`[Baileys Auto-Purge] Sesi ${sessionId} terputus permanen (status ${statusCode}). Menghapus kredensial & data sesi...`);
            const existingMeta = getSessionById(sessionId);
            const wasPreviouslyLinked = isRegistered || Boolean(sessionData.phoneNumber) || existingMeta?.status === 'connected';
            if (wasPreviouslyLinked) {
              await notifyUserSessionExpired({
                sessionId,
                sessionName: existingMeta?.session_name,
                expiredPhone: sessionData.phoneNumber || existingMeta?.phone_number,
                userId: sessionData.userId || existingMeta?.user_id,
                reason: statusCode === DisconnectReason.loggedOut || statusCode === 401
                  ? 'keluar / terputus dari Perangkat Tertaut di HP'
                  : `terputus permanen (kode ${statusCode})`
              }).catch(() => {});
            }
            await purgeBaileysSessionCompletely(sessionId, sessionData.phoneNumber || undefined);
            return;
          }

          if (!isRegistered && statusCode !== DisconnectReason.restartRequired) {
            // Unregistered QR socket timed out / failed without being scanned: clean up completely
            console.log(`[Baileys Auto-Purge] Sesi QR ${sessionId} belum terhubung/timeout. Menghapus folder & cache...`);
            await purgeBaileysSessionCompletely(sessionId, sessionData.phoneNumber || undefined);
            return;
          }

          // Registered session or post-scan 515 restartRequired: auto-reconnect with retry cap
          const owner = resolveActiveVerifiedOwner(sessionId, sessionData.userId, sessionData.phoneNumber || getCredsPhoneOnDisk(sessionId));
          if (!isOwnerActiveAndRegistered(owner)) {
            console.warn(`[Baileys Auto-Purge] Pemilik sesi ${sessionId} tidak aktif/terdaftar lagi. Menghapus sesi...`);
            await purgeBaileysSessionCompletely(sessionId, sessionData.phoneNumber || undefined);
            return;
          }

          const ownerArStatus = getUserAutoReplyStatus(owner);

          sessionData.retryCount = (sessionData.retryCount || 0) + 1;
          if (sessionData.retryCount > MAX_RECONNECT_RETRIES) {
            clearSessionTimers(sessionId);
            clearMetaAiSession(sessionId);
            if (isRegistered) {
              if (ownerArStatus.is_free_plan && !ownerArStatus.allowed) {
                // Parkir socket dari RAM tanpa menghapus kredensial agar Blast & REST API v1 tetap bisa membangunkan sesi saat dibutuhkan
                await parkSocketToSaveRam(sessionId, false);
                return;
              }
              // Keep registered credentials & DB session intact so watchdog heals cleanly without forcing re-scan
              console.warn(`[Baileys Keep-Alive] Sesi terdaftar ${sessionId} mencapai batas retry cepat (${MAX_RECONNECT_RETRIES}x). Menyimpan kredensial untuk pemulihan watchdog otomatis.`);
              sessionData.status = 'disconnected';
              sessionData.disconnectedSince = sessionData.disconnectedSince || Date.now();
              sessionData.retryCount = 0;
              activeSessions.set(sessionId, sessionData);
              return;
            }
            console.warn(`[Baileys Auto-Purge] Sesi ${sessionId} gagal reconnect ${MAX_RECONNECT_RETRIES}x. Menghapus sesi tidak aktif...`);
            await purgeBaileysSessionCompletely(sessionId, sessionData.phoneNumber || undefined);
            return;
          }

          sessionData.status = 'connecting';
          activeSessions.set(sessionId, sessionData);
          const reconnectDelay =
            statusCode === DisconnectReason.connectionReplaced
              ? 6000
              : Math.min(30000, 2000 * Math.pow(2, Math.max(0, sessionData.retryCount - 1)));
          console.log(
            `[Baileys Auto-Reconnect] Menghubungkan ulang sesi ${sessionId} dalam ${reconnectDelay}ms (percobaan ${sessionData.retryCount}/${MAX_RECONNECT_RETRIES})...`
          );
          clearSessionTimers(sessionId);
          const rTimer = setTimeout(async () => {
            reconnectTimers.delete(sessionId);
            try {
              await credsSaveQueue;
            } catch {}
            if (!resolveActiveVerifiedOwner(sessionId, sessionData.userId, sessionData.phoneNumber || getCredsPhoneOnDisk(sessionId))) {
              await purgeBaileysSessionCompletely(sessionId);
              return;
            }
            getOrStartBaileysSession(
              sessionId,
              phoneNumber || sessionData.phoneNumber || undefined,
              sessionData.userId
            ).catch(() => {});
          }, reconnectDelay);
          reconnectTimers.set(sessionId, rTimer);
        }
      });

      // Attach messages upsert listener
      attachSocketMessageListener(sock, sessionId, sessionData);

      return sessionData;
    } finally {
      sessionStartLocks.delete(sessionId);
    }
  })();

  sessionStartLocks.set(sessionId, initPromise);
  return initPromise;
}

// Request real WhatsApp pairing code via Baileys socket
export async function requestBaileysPairingCode(
  rawSessionId: string,
  phoneNumber: string,
  userId?: string
): Promise<string> {
  const sessionId = sanitizeSessionId(rawSessionId);
  const cleanPhone = normalizePhoneNumber(phoneNumber);
  if (!cleanPhone || cleanPhone.length < 9) {
    throw new Error('Nomor telepon tidak valid. Gunakan format lengkap (contoh: 0812... atau 62812...).');
  }

  clearSessionTimers(sessionId);

  // Safely stop existing sockets on this session ID without deleting DB records yet
  const existing = activeSessions.get(sessionId);
  if (existing && existing.socket) {
    try {
      existing.socket.ev?.removeAllListeners?.('connection.update');
      existing.socket.ev?.removeAllListeners?.('creds.update');
      existing.socket.ev?.removeAllListeners?.('messages.upsert');
      existing.socket.ev?.removeAllListeners?.('messages.update');
      existing.socket.end(undefined);
      existing.socket.ws?.removeAllListeners?.();
    } catch {
      // Ignore
    }
    existing.detachRawHandlers?.();
    clearMetaAiSession(sessionId);
    activeSessions.delete(sessionId);
  }

  const sessionFolder = safeSessionFolderPath(sessionId);
  if (!sessionFolder) {
    throw new Error('ID sesi WhatsApp tidak valid.');
  }
  if (fs.existsSync(sessionFolder)) {
    try {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
    } catch (e) {
      console.warn('[Baileys] Warning cleaning session folder for new pairing:', e);
    }
  }
  fs.mkdirSync(sessionFolder, { recursive: true, mode: 0o700 });

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const version = await resolveBaileysVersion();

  const sock = makeWASocket(buildBaileysSocketConfig(version, BAILEYS_SILENT_LOGGER, state));

  const sessionData: SessionState = {
    sessionId,
    userId,
    socket: sock,
    qrCodeUrl: null,
    pairingCode: null,
    status: 'connecting',
    phoneNumber: cleanPhone,
    lastUpdated: Date.now(),
    handshakeStartedAt: Date.now(),
    retryCount: 0
  };

  activeSessions.set(sessionId, sessionData);

  // Safe sequential credential saving queue for pairing session
  let pairCredsSaveQueue: Promise<void> = Promise.resolve();
  sock.ev.on('creds.update', () => {
    pairCredsSaveQueue = pairCredsSaveQueue.then(async () => {
      try {
        await saveCreds();
        scheduleAuthFolderBackup(sessionId);
      } catch (saveErr) {
        console.warn('[Baileys Pairing] Error saving creds:', saveErr);
      }
    });
  });

  sock.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      const rawSockUser = sock.user?.id ? sock.user.id.split('@')[0].split(':')[0] : '';
      const connectedUser = normalizePhoneNumber(rawSockUser || cleanPhone);
      const owner = resolveActiveVerifiedOwner(sessionId, sessionData.userId || userId, connectedUser);
      if (!isOwnerActiveAndRegistered(owner)) {
        console.warn(`[Baileys Pairing Security] Connected session ${sessionId} has no active registered owner. Purging.`);
        await purgeBaileysSessionCompletely(sessionId, connectedUser);
        return;
      }

      console.log(`[Baileys Pairing] Connected & Linked successfully! User: ${sock.user?.id}`);
      sessionData.status = 'connected';
      sessionData.phoneNumber = connectedUser;
      sessionData.pairingCode = null;
      sessionData.lastUpdated = Date.now();
      sessionData.retryCount = 0;
      sessionData.disconnectedSince = undefined;
      sessionData.userId = owner!.id;
      clearSessionExpiryNotificationCooldown(sessionId, owner!.id, connectedUser);
      activeSessions.set(sessionId, sessionData);
      scheduleAuthFolderBackup(sessionId, true);

      const db = initDbFile();
      const existingDb =
        getSessionById(sessionId) ||
        db.sessions.find(
          s =>
            s.user_id === owner!.id &&
            s.phone_number &&
            normalizePhoneNumber(s.phone_number) === connectedUser
        );
      const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      if (existingDb) {
        updateSession(existingDb.id, {
          id: sessionId,
          status: 'connected',
          phone_number: connectedUser,
          user_id: owner!.id,
          connected_at: existingDb.connected_at || new Date().toISOString(),
          expires_at: existingDb.expires_at || expiryDate
        });
      } else {
          addSession({
            id: sessionId,
            session_name: `WA Pair - ${connectedUser}`,
            phone_number: connectedUser,
            auth_method: 'pairing_code',
            status: 'connected',
            user_id: owner!.id,
            is_primary: true,
            expires_at: expiryDate
          });
        }

        if (
          owner!.role !== 'admin' &&
          owner!.ai_enabled === true &&
          Array.isArray(owner!.meta_ai_verified_phones) &&
          owner!.meta_ai_verified_phones.length > 0 &&
          !isPhoneMetaAiVerifiedForUser(owner, connectedUser)
        ) {
          updateUser(owner!.id, { ai_enabled: false });
        }

        if (owner!.role === 'admin') {
          setTimeout(() => {
            drainSuperadminWaQueue('admin_pairing_open').catch(() => {});
            processPendingSessionExpiryAlerts('admin_pairing_open').catch(() => {});
          }, 2500);
        }
      } else if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isFatal = isFatalDisconnectCode(statusCode);
      const isRegistered = hasRegisteredCredsOnDisk(sessionId);

      console.log(`[Baileys Pairing] Connection closed ${sessionId}, code: ${statusCode}, registered: ${isRegistered}`);

      const latestSession = activeSessions.get(sessionId);
      if (latestSession && latestSession.socket && latestSession.socket !== sock) {
        return;
      }

      try {
        sessionData.detachRawHandlers?.();
        sock.ev?.removeAllListeners?.('connection.update');
        sock.ev?.removeAllListeners?.('creds.update');
        sock.ev?.removeAllListeners?.('messages.upsert');
        sock.ev?.removeAllListeners?.('messages.update');
        sock.ws?.removeAllListeners?.();
      } catch {
        // Ignore listener cleanup errors on closed pairing socket
      }

      sessionData.socket = null;

      if (isFatal || (!isRegistered && statusCode !== DisconnectReason.restartRequired)) {
        console.warn(`[Baileys Pairing Auto-Purge] Sesi pairing ${sessionId} terputus/batal (${statusCode}). Menghapus sesi & folder...`);
        const existingMeta = getSessionById(sessionId);
        if (isFatal && (isRegistered || existingMeta?.status === 'connected')) {
          await notifyUserSessionExpired({
            sessionId,
            sessionName: existingMeta?.session_name,
            expiredPhone: sessionData.phoneNumber || cleanPhone || existingMeta?.phone_number,
            userId: sessionData.userId || userId || existingMeta?.user_id,
            reason: statusCode === DisconnectReason.loggedOut || statusCode === 401
              ? 'keluar / terputus dari Perangkat Tertaut di HP'
              : `terputus permanen (kode ${statusCode})`
          }).catch(() => {});
        }
        await purgeBaileysSessionCompletely(sessionId, cleanPhone);
        return;
      }

      const pairOwner = resolveActiveVerifiedOwner(sessionId, sessionData.userId || userId, sessionData.phoneNumber || cleanPhone);
      const pairArStatus = pairOwner ? getUserAutoReplyStatus(pairOwner) : null;

      sessionData.retryCount = (sessionData.retryCount || 0) + 1;
      if (sessionData.retryCount > MAX_RECONNECT_RETRIES) {
        clearSessionTimers(sessionId);
        clearMetaAiSession(sessionId);
        if (isRegistered) {
          if (pairArStatus && pairArStatus.is_free_plan && !pairArStatus.allowed) {
            await parkSocketToSaveRam(sessionId, false);
            return;
          }
          console.warn(`[Baileys Pairing Keep-Alive] Sesi terdaftar ${sessionId} menyimpan kredensial untuk pemulihan watchdog.`);
          sessionData.status = 'disconnected';
          sessionData.disconnectedSince = sessionData.disconnectedSince || Date.now();
          sessionData.retryCount = 0;
          activeSessions.set(sessionId, sessionData);
          return;
        }
        await purgeBaileysSessionCompletely(sessionId, cleanPhone);
        return;
      }

      sessionData.status = 'connecting';
      activeSessions.set(sessionId, sessionData);
      console.log(
        `[Baileys Pairing] Stream closed (${statusCode}). Flushing credentials and reconnecting ${sessionId}...`
      );
      clearSessionTimers(sessionId);
      const rTimer = setTimeout(async () => {
        reconnectTimers.delete(sessionId);
        try {
          await pairCredsSaveQueue;
        } catch {}
        getOrStartBaileysSession(sessionId, cleanPhone, sessionData.userId || userId).catch(() => {});
      }, 1500);
      reconnectTimers.set(sessionId, rTimer);
    }
  });

  // Attach messages upsert listener to pairing socket as well
  attachSocketMessageListener(sock, sessionId, sessionData);

  // Wait for WebSocket connection to establish before requesting code
  let tries = 0;
  while (tries < 18 && !sock.ws?.isOpen) {
    await delay(300);
    tries++;
  }
  await delay(1000);

  if (!sock.authState.creds.registered) {
    try {
      const rawCode = await sock.requestPairingCode(cleanPhone);
      const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
      sessionData.pairingCode = formattedCode;
      sessionData.lastUpdated = Date.now();
      activeSessions.set(sessionId, sessionData);

      // Create connecting session record in database
      const existingDbSess = getSessionById(sessionId);
      const defaultExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      if (!existingDbSess) {
        addSession({
          id: sessionId,
          session_name: `WA Pair - ${cleanPhone}`,
          phone_number: cleanPhone,
          auth_method: 'pairing_code',
          status: 'connecting',
          user_id: userId || sessionData.userId,
          is_primary: true,
          expires_at: defaultExpires
        });
      } else if ((userId || sessionData.userId) && !existingDbSess.user_id) {
        updateSession(existingDbSess.id, {
          user_id: userId || sessionData.userId,
          id: sessionId,
          expires_at: defaultExpires
        });
      }

      return formattedCode;
    } catch (err: any) {
      console.error('[Baileys] Request pairing code error:', err);
      await purgeBaileysSessionCompletely(sessionId, cleanPhone);
      throw new Error(err?.message || 'Gagal meminta Kode Pairing dari WhatsApp.');
    }
  } else {
    throw new Error('Sesi ini sudah terdaftar dan terhubung.');
  }
}

export function getLiveSessionRuntimeStatus(dbSess: {
  id: string;
  user_id?: string;
  phone_number?: string;
}): {
  runtime_status: 'connected' | 'connecting' | 'disconnected';
  has_registered_creds: boolean;
} {
  let mem = activeSessions.get(dbSess.id);
  if (!mem) {
    const cleanPhone = normalizePhoneNumber(dbSess.phone_number || '');
    for (const s of activeSessions.values()) {
      if (s.userId && dbSess.user_id && s.userId !== dbSess.user_id) continue;
      if (
        s.sessionId === dbSess.id ||
        (cleanPhone.length >= 8 && s.phoneNumber && normalizePhoneNumber(s.phoneNumber) === cleanPhone)
      ) {
        mem = s;
        break;
      }
    }
  }

  let hasCreds = hasRegisteredCredsOnDisk(dbSess.id);
  if (!hasCreds && mem && mem.sessionId !== dbSess.id) {
    hasCreds = hasRegisteredCredsOnDisk(mem.sessionId);
  }

  if (mem) {
    if (mem.status === 'connected' && isSocketTrulyOpen(mem.socket)) {
      return { runtime_status: 'connected', has_registered_creds: true };
    }
    if (mem.status === 'connecting') {
      return { runtime_status: 'connecting', has_registered_creds: hasCreds };
    }
  }

  return { runtime_status: 'disconnected', has_registered_creds: hasCreds };
}

export async function reconnectBaileysSessionForUser(
  rawSessionId: string,
  userId?: string
): Promise<{
  connected: boolean;
  runtime_status: 'connected' | 'connecting' | 'disconnected';
  needs_rescan: boolean;
  session_id: string;
  phone_number?: string;
}> {
  const sessionId = sanitizeSessionId(rawSessionId);
  const dbSess = getSessionById(sessionId);
  const effectiveId = dbSess?.id || sessionId;
  const targetUserId = userId || dbSess?.user_id;

  let hasCreds = hasRegisteredCredsOnDisk(effectiveId);
  if (!hasCreds) {
    hasCreds = await hydrateSessionAuthFolderFromMysql(effectiveId).catch(() => false);
  }
  if (!hasCreds && effectiveId !== sessionId) {
    hasCreds =
      hasRegisteredCredsOnDisk(sessionId) ||
      (await hydrateSessionAuthFolderFromMysql(sessionId).catch(() => false));
  }

  if (!hasCreds) {
    return {
      connected: false,
      runtime_status: 'disconnected',
      needs_rescan: true,
      session_id: effectiveId,
      phone_number: dbSess?.phone_number
    };
  }

  const ensured = await ensureConnectedSessionForUser(targetUserId, effectiveId);
  if (ensured) {
    return {
      connected: true,
      runtime_status: 'connected',
      needs_rescan: false,
      session_id: ensured.sessionId,
      phone_number: ensured.phoneNumber || dbSess?.phone_number
    };
  }

  const mem = activeSessions.get(effectiveId);
  return {
    connected: false,
    runtime_status: mem?.status === 'connecting' ? 'connecting' : 'disconnected',
    needs_rescan: false,
    session_id: effectiveId,
    phone_number: dbSess?.phone_number
  };
}

export function getBaileysSessionStatus(idOrPhone: string) {
  let session = activeSessions.get(idOrPhone);

  if (!session) {
    const cleanPhone = idOrPhone ? idOrPhone.replace(/\D/g, '') : '';
    for (const s of activeSessions.values()) {
      if (
        s.sessionId === idOrPhone ||
        (cleanPhone && s.phoneNumber && s.phoneNumber.includes(cleanPhone)) ||
        (cleanPhone && s.sessionId.includes(cleanPhone))
      ) {
        session = s;
        break;
      }
    }
  }

  if (session) {
    return {
      sessionId: session.sessionId,
      qrCodeUrl: session.qrCodeUrl,
      pairingCode: session.pairingCode,
      status: session.status,
      phoneNumber: session.phoneNumber,
      lastUpdated: session.lastUpdated
    };
  }

  // Fallback to database record if session connected
  try {
    const dbSess = getSessionById(idOrPhone);
    if (dbSess && dbSess.status !== 'disconnected') {
      return {
        sessionId: dbSess.id,
        qrCodeUrl: null,
        pairingCode: null,
        status: dbSess.status,
        phoneNumber: dbSess.phone_number,
        lastUpdated: Date.now()
      };
    }
  } catch {}

  return null;
}

export async function purgeBaileysSessionCompletely(idOrPhone: string, explicitPhone?: string): Promise<void> {
  if (!idOrPhone) return;

  clearSessionTimers(idOrPhone);

  const sess = getSessionById(idOrPhone);
  const targetPhone = normalizePhoneNumber(explicitPhone || sess?.phone_number || idOrPhone.replace(/\D/g, ''));

  // 1. Delete from DB and MySQL Auth Backup immediately
  deleteSession(idOrPhone);
  deleteBaileysAuthFromMysql(idOrPhone).catch(() => {});
  if (sess?.id && sess.id !== idOrPhone) {
    clearSessionTimers(sess.id);
    deleteSession(sess.id);
    deleteBaileysAuthFromMysql(sess.id).catch(() => {});
  }
  if (targetPhone && targetPhone.length >= 8) {
    deleteSession(targetPhone);
  }

  // 2. Terminate matching active sockets & clear timers/dialog state
  const keysToRemove: string[] = [];
  for (const [key, sessionData] of activeSessions.entries()) {
    const memPhone = normalizePhoneNumber(sessionData.phoneNumber || '');
    if (
      key === idOrPhone ||
      (sess && key === sess.id) ||
      (targetPhone &&
        targetPhone.length >= 8 &&
        ((memPhone && memPhone === targetPhone) || key.includes(targetPhone)))
    ) {
      clearSessionTimers(key);
      if (sessionData.socket) {
        try {
          sessionData.socket.ev?.removeAllListeners?.('connection.update');
          sessionData.socket.ev?.removeAllListeners?.('creds.update');
          sessionData.socket.ev?.removeAllListeners?.('messages.upsert');
          sessionData.socket.ev?.removeAllListeners?.('messages.update');
          await Promise.race([
            sessionData.socket.logout().catch(() => {}),
            new Promise(res => setTimeout(res, 600))
          ]);
        } catch {
          // Ignore
        }
        try {
          sessionData.socket.end(undefined);
          sessionData.socket.ws?.removeAllListeners?.();
        } catch {
          // Ignore
        }
      }
      sessionData.detachRawHandlers?.();
      clearMetaAiSession(key);
      keysToRemove.push(key);
    }
  }

  for (const k of keysToRemove) {
    activeSessions.delete(k);
    lastAuthBackupAt.delete(k);
    lastAuthBackupHashes.delete(k);
    cleanSessionFolder(k);
    deleteBaileysAuthFromMysql(k).catch(() => {});
    for (const stateKey of Array.from(commandState.keys())) {
      if (stateKey.startsWith(`${k}:`)) {
        commandState.delete(stateKey);
      }
    }
  }

  // 3. Clean matching session folders on disk
  cleanSessionFolder(idOrPhone);
  if (sess?.id) cleanSessionFolder(sess.id);
  if (targetPhone && targetPhone.length >= 8) {
    cleanSessionFolder(`session_${targetPhone}`);
    cleanSessionFolder(`session_pair_${targetPhone}`);
  }
}

export async function stopBaileysSession(idOrPhone: string) {
  if (!idOrPhone) return;
  console.log(`[Baileys] Stopping and purging session: ${idOrPhone}`);
  await purgeBaileysSessionCompletely(idOrPhone);
}

/**
 * Menutup socket Baileys aktif di RAM tanpa menghapus kredensial disk, backup MySQL, atau record DB,
 * agar RAM tetap hemat ketika respon otomatis nonaktif/habis sementara WA Blast & REST API v1 tetap bisa membangunkan sesi.
 */
export async function parkSocketToSaveRam(sessionId: string, markDbDisconnected = false): Promise<boolean> {
  if (!sessionId) return false;
  clearSessionTimers(sessionId);
  const sessionData = activeSessions.get(sessionId);
  if (sessionData) {
    if (sessionData.socket) {
      try {
        sessionData.socket.ev?.removeAllListeners?.('connection.update');
        sessionData.socket.ev?.removeAllListeners?.('creds.update');
        sessionData.socket.ev?.removeAllListeners?.('messages.upsert');
        sessionData.socket.ev?.removeAllListeners?.('messages.update');
        sessionData.socket.end(undefined);
        sessionData.socket.ws?.removeAllListeners?.();
      } catch {
        // Ignore close errors
      }
    }
    sessionData.detachRawHandlers?.();
    clearMetaAiSession(sessionId);
    activeSessions.delete(sessionId);
  }
  if (markDbDisconnected) {
    updateSession(sessionId, { status: 'disconnected' });
  }
  return Boolean(sessionData);
}

/**
 * Menutup socket Baileys aktif di RAM untuk user tertentu tanpa menghapus kredensial login,
 * agar RAM server tetap hemat ketika respon otomatis sedang dimatikan.
 */
export async function stopIdleUserBaileysSockets(userId: string): Promise<number> {
  if (!userId) return 0;
  let closed = 0;
  for (const [sid, sessionData] of Array.from(activeSessions.entries())) {
    const owner = resolveActiveVerifiedOwner(sid, sessionData.userId, sessionData.phoneNumber || undefined);
    if (!owner || owner.id !== userId) continue;
    const closedMem = await parkSocketToSaveRam(sid, false);
    if (closedMem) closed++;
  }
  if (closed > 0) {
    console.log(`[Baileys RAM Saver] Memarkir ${closed} socket idle milik user ${userId} (kredensial tetap disimpan untuk Blast & API).`);
  }
  return closed;
}

export async function resumeSavedUserBaileysSessions(userId: string): Promise<number> {
  if (!userId) return 0;
  const user = getUserById(userId);
  if (!isOwnerActiveAndRegistered(user)) return 0;
  const arStatus = getUserAutoReplyStatus(user);
  if (!arStatus.allowed) return 0;

  let started = 0;
  const userSessions = getSessionsByUserId(userId);
  for (const s of userSessions) {
    if (!s.id) continue;
    if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) continue;
    const mem = activeSessions.get(s.id);
    if (mem && mem.status === 'connected' && isSocketTrulyOpen(mem.socket)) continue;
    let hasCreds = hasRegisteredCredsOnDisk(s.id);
    if (!hasCreds) {
      hasCreds = await hydrateSessionAuthFolderFromMysql(s.id).catch(() => false);
    }
    if (hasCreds) {
      getOrStartBaileysSession(s.id, s.phone_number, userId).catch(() => {});
      started++;
    }
  }
  return started;
}

export async function purgeBaileysSessionsForUser(userId: string): Promise<number> {
  if (!userId) return 0;
  const db = initDbFile();
  const targetUser = getUserById(userId);
  const toPurge = new Set<string>();

  for (const s of db.sessions) {
    if (s.user_id === userId || (targetUser && s.user_id === targetUser.id) || isSessionOwnedByUserId(s.id, userId)) {
      toPurge.add(s.id);
    }
  }
  for (const [sid, mem] of activeSessions.entries()) {
    if (mem.userId === userId || (targetUser && mem.userId === targetUser.id) || isSessionOwnedByUserId(sid, userId)) {
      toPurge.add(sid);
    }
  }
  if (fs.existsSync(AUTH_DIR)) {
    for (const folder of fs.readdirSync(AUTH_DIR)) {
      if (isSessionOwnedByUserId(folder, userId)) toPurge.add(folder);
    }
  }

  for (const sid of toPurge) {
    await purgeBaileysSessionCompletely(sid);
  }
  return toPurge.size;
}

let pruneInFlightPromise: Promise<number> | null = null;
let lastPruneCompletedAt = 0;
let lastMysqlAuthPruneAt = 0;

/**
 * Automatically purges Baileys sessions that are:
 * - Inactive/disconnected (`status === 'disconnected'` with no live socket, or expired `expires_at`)
 * - Stale unscanned QR/pairing handshakes (`> 3 min` without registered creds)
 * - Unregistered/orphan (owner user deleted, inactive, or email unverified, OR orphan auth folder whose phone/session is not registered in app)
 */
export async function pruneInactiveAndUnregisteredBaileysSessions(force = false): Promise<number> {
  if (pruneInFlightPromise) {
    return pruneInFlightPromise;
  }
  const now = Date.now();
  if (!force && now - lastPruneCompletedAt < PRUNE_COOLDOWN_MS) {
    return 0;
  }

  pruneInFlightPromise = (async () => {
    let purgedCount = 0;
    const db = initDbFile();
    const purgedIds = new Set<string>();

    const doPurge = async (sid: string, phone?: string, reason?: string) => {
      if (!sid || purgedIds.has(sid)) return;
      purgedIds.add(sid);
      purgedCount++;
      console.log(`[Baileys Auto-Purge] Menghapus sesi "${sid}" (${reason || 'inactive/unregistered'}).`);
      await purgeBaileysSessionCompletely(sid, phone);
    };

    try {
      // 1. Check all DB Baileys sessions
      for (const s of [...db.sessions]) {
        const mem = activeSessions.get(s.id);
        const hasOpenSocket = Boolean(mem && mem.status === 'connected' && isSocketTrulyOpen(mem.socket));

    const owner = resolveActiveVerifiedOwner(s.id, s.user_id, s.phone_number);
    if (!isOwnerActiveAndRegistered(owner)) {
      await doPurge(s.id, s.phone_number, 'pemilik akun tidak terdaftar atau nonaktif');
      continue;
    }

    if (s.expires_at && new Date(s.expires_at).getTime() < now) {
      if (s.phone_number) {
        await notifyUserSessionExpired({
          sessionId: s.id,
          sessionName: s.session_name,
          expiredPhone: s.phone_number,
          userId: s.user_id,
          reason: 'masa aktif sesi login telah habis (expired)'
        }).catch(() => {});
      }
      await doPurge(s.id, s.phone_number, 'masa aktif sesi berakhir');
      continue;
    }

    if (s.status === 'disconnected' && !hasOpenSocket && !hasRegisteredCredsOnDisk(s.id)) {
      if (s.phone_number && s.connected_at) {
        await notifyUserSessionExpired({
          sessionId: s.id,
          sessionName: s.session_name,
          expiredPhone: s.phone_number,
          userId: s.user_id,
          reason: 'sesi WhatsApp terputus dan kredensial login tidak aktif lagi'
        }).catch(() => {});
      }
      await doPurge(s.id, s.phone_number, 'status sesi disconnected tanpa kredensial tersimpan');
      continue;
    }

    const updatedMs = new Date(s.updated_at || s.created_at || 0).getTime();
    if (
      s.status === 'connecting' &&
      !hasRegisteredCredsOnDisk(s.id) &&
      (!mem || now - mem.handshakeStartedAt > UNSCANNED_HANDSHAKE_TTL_MS) &&
      now - updatedMs > UNSCANNED_HANDSHAKE_TTL_MS
    ) {
      await doPurge(s.id, s.phone_number, 'handshake QR/pairing kadaluarsa tanpa scan');
      continue;
    }
  }

  // 2. Check all in-memory Baileys sockets
  for (const [sid, mem] of Array.from(activeSessions.entries())) {
    if (purgedIds.has(sid)) continue;
    const summary = readCredsSummary(sid);
    const dbSess = getSessionById(sid);
    const owner = resolveActiveVerifiedOwner(sid, mem.userId, mem.phoneNumber || summary.phone);

    if (!isOwnerActiveAndRegistered(owner)) {
      await doPurge(sid, mem.phoneNumber || summary.phone, 'socket memori tidak memiliki pemilik terdaftar aktif');
      continue;
    }

    if (dbSess?.expires_at && new Date(dbSess.expires_at).getTime() < now) {
      await doPurge(sid, mem.phoneNumber || summary.phone, 'masa aktif sesi di memori berakhir');
      continue;
    }

    if (!summary.registered && now - mem.handshakeStartedAt > UNSCANNED_HANDSHAKE_TTL_MS) {
      await doPurge(sid, mem.phoneNumber || undefined, 'QR/pairing belum tersambung > 3 menit');
      continue;
    }

    const arStatus = getUserAutoReplyStatus(owner);
    if (arStatus.is_free_plan && !arStatus.allowed && summary.registered && mem.status !== 'connecting') {
      const lastActivityAt = Math.max(mem.lastOutgoingAt || 0, mem.lastUpdated || 0);
      if (now - lastActivityAt >= FREE_IDLE_SOCKET_TTL_MS) {
        console.log(`[Baileys RAM Saver] Memarkir socket idle ${sid} milik user gratis ${owner!.username} (kredensial tetap disimpan untuk Blast & API).`);
        await parkSocketToSaveRam(sid, false);
        continue;
      }
    }

    if (mem.status === 'disconnected' && !isSocketTrulyOpen(mem.socket)) {
      if (!summary.registered) {
        await doPurge(sid, mem.phoneNumber || summary.phone, 'socket terputus tanpa kredensial');
        continue;
      }
      // Hapus objek socket yang sudah mati > 10 menit dari RAM tanpa menghapus kredensial tersimpan
      if (mem.disconnectedSince && now - mem.disconnectedSince > 10 * 60 * 1000) {
        clearSessionTimers(sid);
        clearMetaAiSession(sid);
        activeSessions.delete(sid);
      }
    }
  }

  // 3. Check all local disk auth folders
  if (fs.existsSync(AUTH_DIR)) {
    for (const entry of fs.readdirSync(AUTH_DIR)) {
      if (purgedIds.has(entry)) continue;
      const folderPath = safeSessionFolderPath(entry);
      if (!folderPath) continue;
      try {
        const stat = fs.lstatSync(folderPath);
        if (!stat.isDirectory()) continue;

        const mem = activeSessions.get(entry);
        const dbSess = getSessionById(entry);
        const { registered: isRegistered, phone: credsPhone } = readCredsSummary(entry);

        if (!isRegistered) {
          const isFreshConnecting = mem && mem.status === 'connecting' && now - mem.handshakeStartedAt <= UNSCANNED_HANDSHAKE_TTL_MS;
          if (!isFreshConnecting && now - stat.mtimeMs > UNSCANNED_HANDSHAKE_TTL_MS) {
            await doPurge(entry, credsPhone, 'folder auth tidak terdaftar & kadaluarsa');
          }
          continue;
        }

        const owner = resolveActiveVerifiedOwner(entry, dbSess?.user_id || mem?.userId, dbSess?.phone_number || credsPhone);
        if (!isOwnerActiveAndRegistered(owner)) {
          await doPurge(entry, credsPhone, 'folder auth milik user yang sudah terhapus/nonaktif');
          continue;
        }

        if (dbSess?.expires_at && new Date(dbSess.expires_at).getTime() < now) {
          await doPurge(entry, credsPhone, 'folder auth sudah melewati tanggal kedaluwarsa');
          continue;
        }

        // Recover DB session entry when disk creds remain valid after build/restart
        if (!dbSess && owner) {
          addSession({
            id: entry,
            session_name: `WA - ${credsPhone || entry}`,
            phone_number: credsPhone || '',
            auth_method: 'qr_code',
            status: 'connected',
            user_id: owner.id,
            is_primary: true
          });
        }
      } catch {
        // Ignore stat race
      }
    }
  }

      // 4. Check MySQL backed up Baileys auth keys (throttled to reduce MySQL queries)
      if (isMysqlConfigured() && (force || now - lastMysqlAuthPruneAt >= MYSQL_AUTH_PRUNE_INTERVAL_MS)) {
        lastMysqlAuthPruneAt = now;
        const mysqlAuthIds = await loadAllBaileysAuthSessionIdsFromMysql().catch(() => []);
        for (const sid of mysqlAuthIds) {
          if (purgedIds.has(sid)) continue;
          const dbSess = getSessionById(sid);
          const owner = resolveActiveVerifiedOwner(sid, dbSess?.user_id, dbSess?.phone_number);
          const isExpired = Boolean(dbSess?.expires_at && new Date(dbSess.expires_at).getTime() < now);
          const hasDiskCreds = hasRegisteredCredsOnDisk(sid);
          if (!isOwnerActiveAndRegistered(owner) || isExpired || (!dbSess && !hasDiskCreds)) {
            await doPurge(sid, dbSess?.phone_number, 'backup auth MySQL tidak memiliki pemilik/sesi aktif atau sudah expired');
          }
        }
      }

      return purgedCount;
    } finally {
      lastPruneCompletedAt = Date.now();
      pruneInFlightPromise = null;
    }
  })();

  return pruneInFlightPromise;
}

// Helper to check if a session folder has valid registered credentials on disk
function hasRegisteredCredsOnDisk(sessionId: string): boolean {
  return readCredsSummary(sessionId).registered;
}

export function getPreferredSystemBaileysSessionId(): string | null {
  const db = initDbFile();
  const isAdminUser = (uid?: string) => {
    if (!uid) return false;
    const u = getUserById(uid);
    return Boolean(u && u.role === 'admin' && u.is_active);
  };

  // 1. Only pick live connected sessions owned by an Admin/Superadmin
  const connectedAdmin = Array.from(activeSessions.values()).filter(
    s => s.status === 'connected' && isSocketTrulyOpen(s.socket) && isAdminUser(s.userId)
  );
  if (connectedAdmin.length > 0) {
    const prim = connectedAdmin.find(s => s.is_primary);
    return prim ? prim.sessionId : connectedAdmin[0].sessionId;
  }

  // 2. Fallback to admin DB sessions that are active/connected
  const adminDb = db.sessions.filter(
    s => s.status === 'connected' && isAdminUser(s.user_id)
  );
  const primDb = adminDb.find(s => s.is_primary);
  return primDb?.id || adminDb[0]?.id || null;
}

// Auto-restore all saved active WhatsApp sessions on server startup
let isRestoringSessions = false;
export async function restoreSavedBaileysSessions() {
  if (isRestoringSessions) return;
  isRestoringSessions = true;
  try {
    // Purge expired or ownerless sessions BEFORE restoring (never purges valid registered disk creds)
    await pruneInactiveAndUnregisteredBaileysSessions(true).catch(() => {});

    const dbSessions = getWhatsAppSessions();
    const diskFolders = fs.existsSync(AUTH_DIR) ? fs.readdirSync(AUTH_DIR) : [];
    const mysqlBackedUpIds = await loadAllBaileysAuthSessionIdsFromMysql().catch(() => []);

    const sessionIdsToRestore = new Set<string>();
    const skippedIdleFreeIds = new Set<string>();

    const canAutoStartOwner = (owner: ReturnType<typeof getUserById>, sid: string): boolean => {
      if (!isOwnerActiveAndRegistered(owner)) return false;
      const arStatus = getUserAutoReplyStatus(owner);
      if (arStatus.is_free_plan && !arStatus.allowed) {
        skippedIdleFreeIds.add(sid);
        return false;
      }
      return true;
    };

    for (const sid of mysqlBackedUpIds) {
      const dbSess = getSessionById(sid);
      const owner = resolveActiveVerifiedOwner(sid, dbSess?.user_id, dbSess?.phone_number);
      if (!canAutoStartOwner(owner, sid)) continue;
      if (dbSess?.expires_at && new Date(dbSess.expires_at).getTime() < Date.now()) continue;

      await hydrateSessionAuthFolderFromMysql(sid);
      if (hasRegisteredCredsOnDisk(sid)) {
        sessionIdsToRestore.add(sid);
      }
    }

    dbSessions.forEach(s => {
      if (s.id && hasRegisteredCredsOnDisk(s.id)) {
        const owner = resolveActiveVerifiedOwner(s.id, s.user_id, s.phone_number);
        const notExpired = !s.expires_at || new Date(s.expires_at).getTime() >= Date.now();
        if (canAutoStartOwner(owner, s.id) && notExpired) {
          sessionIdsToRestore.add(s.id);
        }
      }
    });

    diskFolders.forEach(folder => {
      const folderPath = safeSessionFolderPath(folder);
      if (!folderPath) return;
      if (fs.lstatSync(folderPath).isDirectory() && hasRegisteredCredsOnDisk(folder)) {
        const dbSess = getSessionById(folder);
        const credsPhone = getCredsPhoneOnDisk(folder);
        const owner = resolveActiveVerifiedOwner(folder, dbSess?.user_id, dbSess?.phone_number || credsPhone);
        const notExpired = !dbSess?.expires_at || new Date(dbSess.expires_at).getTime() >= Date.now();
        if (canAutoStartOwner(owner, folder) && notExpired) {
          sessionIdsToRestore.add(folder);
        }
      }
    });

    console.log(
      `[Baileys Persistent Storage] Found ${sessionIdsToRestore.size} active WhatsApp session(s) to restore (skipped ${skippedIdleFreeIds.size} idle free session(s) to save RAM).`
    );

    // Notify owners only for genuinely broken/expired sessions (never mark idle free Blast/API standby sessions as disconnected)
    for (const s of dbSessions) {
      if (s.id && s.status === 'connected' && !sessionIdsToRestore.has(s.id)) {
        if (skippedIdleFreeIds.has(s.id)) continue;
        updateSession(s.id, { status: 'disconnected' });
        const owner = resolveActiveVerifiedOwner(s.id, s.user_id, s.phone_number);
        if (!isOwnerActiveAndRegistered(owner)) continue;
        const isExpiredByDate = Boolean(s.expires_at && new Date(s.expires_at).getTime() < Date.now());
        await notifyUserSessionExpired({
          sessionId: s.id,
          sessionName: s.session_name,
          expiredPhone: s.phone_number,
          userId: owner!.id,
          reason: isExpiredByDate
            ? 'masa aktif sesi berakhir saat aplikasi di-restart'
            : 'kredensial login tidak ditemukan setelah build/restart server'
        }).catch(() => {});
      }
    }

    for (const sid of sessionIdsToRestore) {
      const existing = activeSessions.get(sid);
      if (!existing || existing.status !== 'connected' || !isSocketTrulyOpen(existing.socket)) {
        try {
          console.log(`[Baileys Auto-Restore] Rehydrating session: ${sid}...`);
          const dbSess = getSessionById(sid);
          await getOrStartBaileysSession(sid, dbSess?.phone_number, dbSess?.user_id);
          await delay(1500);
        } catch (err) {
          console.error(`[Baileys Auto-Restore Error] Failed to restore session ${sid}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[Baileys Restore Error]', err);
  } finally {
    isRestoringSessions = false;
  }
}

export async function runBaileysPeriodicHealthCheck(): Promise<{
  checked: number;
  healed: number;
  notified: number;
}> {
  const now = Date.now();
  let checked = 0;
  let healed = 0;
  let notified = 0;

  cleanupExpiredCommandStates(now);
  if (recentBotOutgoingTexts.size > 0) {
    for (const [k, time] of recentBotOutgoingTexts.entries()) {
      if (now - time > 45000) recentBotOutgoingTexts.delete(k);
    }
  }

  await pruneInactiveAndUnregisteredBaileysSessions();

  const dbSessions = getWhatsAppSessions();
  for (const s of dbSessions) {
    if (!s.id || s.status !== 'connected') continue;
    if (s.expires_at && new Date(s.expires_at).getTime() < now) continue;
    checked++;

    const mem = activeSessions.get(s.id);
    if (mem && mem.status === 'connected' && isSocketTrulyOpen(mem.socket)) {
      continue;
    }

    const isConnectingRecently =
      mem && mem.status === 'connecting' && now - mem.lastUpdated < 35000;
    if (isConnectingRecently) continue;

    const owner = resolveActiveVerifiedOwner(s.id, s.user_id, s.phone_number);
    if (!isOwnerActiveAndRegistered(owner)) continue;

    // Jangan membangunkan sesi user gratis yang respon otomatisnya sedang nonaktif/habis agar RAM server hemat
    const arStatus = getUserAutoReplyStatus(owner);
    if (arStatus.is_free_plan && !arStatus.allowed) continue;

    let hasCreds = hasRegisteredCredsOnDisk(s.id);
    if (!hasCreds) {
      hasCreds = await hydrateSessionAuthFolderFromMysql(s.id).catch(() => false);
    }

    if (!hasCreds) {
      updateSession(s.id, { status: 'disconnected' });
      const alertRes = await notifyUserSessionExpired({
        sessionId: s.id,
        sessionName: s.session_name,
        expiredPhone: s.phone_number,
        userId: owner!.id,
        reason: 'kredensial login WhatsApp sudah tidak valid atau terputus'
      }).catch(() => ({ notified: false }));
      if (alertRes.notified) notified++;
      continue;
    }

    if (
      mem &&
      mem.status === 'disconnected' &&
      mem.disconnectedSince &&
      now - mem.disconnectedSince >= 5 * 60 * 1000
    ) {
      const alertRes = await notifyUserSessionExpired({
        sessionId: s.id,
        sessionName: s.session_name,
        expiredPhone: s.phone_number,
        userId: owner!.id,
        reason: 'koneksi WhatsApp terputus lebih dari 5 menit dan gagal pulih otomatis'
      }).catch(() => ({ notified: false }));
      if (alertRes.notified) notified++;
    }

    console.log(
      `[Baileys Watchdog] Auto-healing session ${s.id} (${s.phone_number || 'active'})...`
    );
    healed++;
    getOrStartBaileysSession(s.id, s.phone_number, owner!.id || s.user_id).catch(() => {});
  }

  if (getSuperadminWaQueue().length > 0 && resolveConnectedSuperadminSession()) {
    drainSuperadminWaQueue('watchdog').catch(() => {});
  }

  const pendingRes = await processPendingSessionExpiryAlerts('watchdog').catch(() => ({
    checked: 0,
    sent: 0,
    cancelled: 0,
    waiting: 0
  }));
  notified += pendingRes.sent;

  return { checked, healed, notified };
}

// Background Keep-Alive, Auto-Heal, Expiry Check & Notification Watchdog (every 120s)
const baileysWatchdogTimer = setInterval(() => {
  runBaileysPeriodicHealthCheck().catch(() => {});
}, 120000);
baileysWatchdogTimer.unref?.();

export function shutdownBaileysManager(): void {
  clearInterval(baileysWatchdogTimer);
  for (const sid of Array.from(authBackupTimers.keys())) {
    clearSessionTimers(sid);
  }
  for (const sid of Array.from(reconnectTimers.keys())) {
    clearSessionTimers(sid);
  }
  for (const [sid, sessionData] of activeSessions.entries()) {
    try {
      sessionData.socket?.ev?.removeAllListeners?.('connection.update');
      sessionData.socket?.ev?.removeAllListeners?.('creds.update');
      sessionData.socket?.ev?.removeAllListeners?.('messages.upsert');
      sessionData.socket?.ev?.removeAllListeners?.('messages.update');
      sessionData.socket?.end?.(undefined);
      sessionData.socket?.ws?.removeAllListeners?.();
    } catch {
      // Ignore shutdown socket errors
    }
    sessionData.detachRawHandlers?.();
    clearMetaAiSession(sid);
  }
  activeSessions.clear();
  sessionStartLocks.clear();
  lastAuthBackupAt.clear();
  lastAuthBackupHashes.clear();
  commandState.clear();
  processedMessageIds.clear();
  recentBotOutgoingTexts.clear();
}

async function resolveTargetSessionForOutgoing(
  idOrPhone: string,
  options?: { userId?: string; allowAdminFallback?: boolean }
): Promise<{ targetSession: SessionState; sessionUserId?: string }> {
  const db = initDbFile();

  const resolvedDbById = idOrPhone ? getSessionById(idOrPhone) : null;
  const targetUserId =
    options?.userId ||
    resolvedDbById?.user_id ||
    (idOrPhone ? extractUserIdFromSessionId(idOrPhone, db.users) : undefined);

  const belongsToTargetUser = (s: { sessionId?: string; id?: string; userId?: string; user_id?: string }) => {
    if (!targetUserId) return true;
    const sid = s.sessionId || s.id || '';
    const uid = s.userId || s.user_id || '';
    return uid === targetUserId || (Boolean(sid) && isSessionOwnedByUserId(sid, targetUserId));
  };

  let targetSession: SessionState | undefined = idOrPhone ? activeSessions.get(idOrPhone) : undefined;
  if (targetSession && (!belongsToTargetUser(targetSession) || targetSession.status !== 'connected' || !isSocketTrulyOpen(targetSession.socket))) {
    targetSession = undefined;
  }

  if (!targetSession) {
    const cleanId = idOrPhone ? idOrPhone.replace(/\D/g, '') : '';
    for (const s of activeSessions.values()) {
      if (s.status === 'connected' && isSocketTrulyOpen(s.socket) && belongsToTargetUser(s)) {
        if (
          s.sessionId === idOrPhone ||
          (cleanId.length >= 8 && s.phoneNumber && normalizePhoneNumber(s.phoneNumber) === normalizePhoneNumber(cleanId))
        ) {
          targetSession = s;
          break;
        }
      }
    }
  }

  if (!targetSession && targetUserId) {
    const userConnected = Array.from(activeSessions.values()).filter(
      s => s.status === 'connected' && isSocketTrulyOpen(s.socket) && belongsToTargetUser(s)
    );
    targetSession = userConnected.find(s => s.is_primary) || userConnected[0];
  }

  if (!targetSession && (!targetUserId || options?.allowAdminFallback)) {
    const adminSysId = getPreferredSystemBaileysSessionId();
    if (adminSysId) {
      const candidate = activeSessions.get(adminSysId);
      if (candidate && candidate.status === 'connected' && isSocketTrulyOpen(candidate.socket)) {
        targetSession = candidate;
      }
    }
  }

  if (!targetSession) {
    const candidateFolders: string[] = [];
    const now = Date.now();
    const isNotExpiredSession = (sess: { expires_at?: string } | null | undefined) =>
      !sess?.expires_at || Date.parse(sess.expires_at) >= now;

    if (
      idOrPhone &&
      (!targetUserId || resolvedDbById?.user_id === targetUserId || isSessionOwnedByUserId(idOrPhone, targetUserId)) &&
      isNotExpiredSession(resolvedDbById)
    ) {
      candidateFolders.push(idOrPhone);
    }

    const userCandidateDb = [...db.sessions]
      .filter(s => s.id && belongsToTargetUser(s) && isNotExpiredSession(s))
      .sort((a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)));

    for (const s of userCandidateDb) {
      if (!candidateFolders.includes(s.id)) {
        candidateFolders.push(s.id);
      }
    }

    for (const folderId of candidateFolders) {
      let hasCreds = hasRegisteredCredsOnDisk(folderId);
      if (!hasCreds) {
        hasCreds = await hydrateSessionAuthFolderFromMysql(folderId).catch(() => false);
      }
      if (hasCreds) {
        console.log(`[Baileys Auto-Connect] Waking session "${folderId}" for outgoing Blast/API dispatch...`);
        const sessMeta = getSessionById(folderId);
        targetSession = await getOrStartBaileysSession(folderId, sessMeta?.phone_number, sessMeta?.user_id || targetUserId);
        let waitCount = 0;
        while (waitCount < 14 && targetSession && targetSession.status !== 'connected') {
          await delay(500);
          waitCount++;
        }
        if (targetSession && targetSession.status === 'connected' && isSocketTrulyOpen(targetSession.socket)) {
          targetSession.lastOutgoingAt = Date.now();
          break;
        }
        targetSession = undefined;
      }
    }

    if (!targetSession && targetUserId) {
      const fallbackEntry = await ensureConnectedSessionForUser(targetUserId, idOrPhone || undefined);
      if (fallbackEntry) {
        const mem = activeSessions.get(fallbackEntry.sessionId);
        if (mem && mem.status === 'connected' && isSocketTrulyOpen(mem.socket)) {
          mem.lastOutgoingAt = Date.now();
          targetSession = mem;
        }
      }
    }
  }

  if (!targetSession) {
    const connectingSession = Array.from(activeSessions.values()).find(
      s => s.status === 'connecting' && belongsToTargetUser(s)
    );
    if (connectingSession) {
      let waitRetry = 0;
      while (waitRetry < 10 && connectingSession.status === 'connecting') {
        await delay(500);
        waitRetry++;
      }
      if (connectingSession.status === 'connected' && isSocketTrulyOpen(connectingSession.socket)) {
        targetSession = connectingSession;
      }
    }
  }

  if (!targetSession || !targetSession.socket || targetSession.status !== 'connected' || !isSocketTrulyOpen(targetSession.socket)) {
    throw new Error('Gagal terhubung ke WhatsApp Sesi milik akun ini. Pastikan nomor WhatsApp Anda sudah terhubung (Scan QR / Kode Pairing) di menu Koneksi WA.');
  }

  targetSession.lastOutgoingAt = Date.now();

  const sessionUserId =
    targetUserId ||
    targetSession.userId ||
    extractUserIdFromSessionId(targetSession.sessionId, db.users);

  return { targetSession, sessionUserId };
}

export interface BaileysMediaPayload {
  mediaType: 'image' | 'document' | 'video' | 'audio';
  mediaBuffer?: Buffer;
  mediaUrl?: string;
  mimetype?: string;
  fileName?: string;
  caption?: string;
  text?: string;
  sendTextSeparately?: boolean;
}

export async function sendBaileysMediaMessage(
  idOrPhone: string,
  recipientPhone: string,
  payload: BaileysMediaPayload,
  options?: { userId?: string; isBroadcast?: boolean; skipLog?: boolean; skipQuota?: boolean; allowAdminFallback?: boolean }
) {
  const cleanRecipient = normalizePhoneNumber(recipientPhone);
  if (!cleanRecipient || cleanRecipient.length < 8) {
    throw new Error(`Nomor WhatsApp tujuan tidak valid (${recipientPhone}).`);
  }

  const jid = `${cleanRecipient}@s.whatsapp.net`;
  let { targetSession, sessionUserId } = await resolveTargetSessionForOutgoing(idOrPhone, options);

  const mediaData: any = payload.mediaBuffer
    ? payload.mediaBuffer
    : payload.mediaUrl
      ? { url: payload.mediaUrl }
      : null;

  if (!mediaData) {
    throw new Error('Konten media atau dokumen kosong.');
  }

  const standaloneText = payload.text ? String(payload.text).trim() : '';
  const captionText = payload.caption ? String(payload.caption).trim() : '';

  const buildBaileysContent = () => {
    if (payload.mediaType === 'image') {
      return {
        image: mediaData,
        ...(captionText ? { caption: captionText } : {}),
        ...(payload.mimetype ? { mimetype: payload.mimetype } : {})
      };
    }
    if (payload.mediaType === 'video') {
      return {
        video: mediaData,
        ...(captionText ? { caption: captionText } : {}),
        ...(payload.mimetype ? { mimetype: payload.mimetype } : {})
      };
    }
    if (payload.mediaType === 'audio') {
      return {
        audio: mediaData,
        mimetype: payload.mimetype || 'audio/mpeg',
        ptt: false
      };
    }
    return {
      document: mediaData,
      mimetype: payload.mimetype || 'application/pdf',
      fileName: payload.fileName || 'document.pdf',
      ...(captionText ? { caption: captionText } : {})
    };
  };

  const logPreview =
    [
      standaloneText || '',
      `[${payload.mediaType.toUpperCase()}${payload.fileName ? `: ${payload.fileName}` : ''}]`,
      captionText || ''
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 1000);

  console.log(`[Baileys Outgoing Media:${payload.mediaType}] Sending to ${jid} via session ${targetSession.sessionId}...`);

  let result: any = null;
  try {
    await targetSession.socket.sendPresenceUpdate('composing', jid).catch(() => {});
    await delay(200);

    if (standaloneText && (payload.sendTextSeparately || captionText || payload.mediaType === 'audio')) {
      recordBotOutgoing(standaloneText);
      await Promise.race([
        targetSession.socket.sendMessage(jid, { text: standaloneText }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout mengirim teks pendamping (18d)')), 18000))
      ]);
      await delay(450);
    }

    if (captionText) recordBotOutgoing(captionText);
    result = await Promise.race([
      targetSession.socket.sendMessage(jid, buildBaileysContent()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Batas waktu pengiriman media/dokumen habis (Timeout 28d)')), 28000))
    ]);
  } catch (firstErr: any) {
    console.warn(`[Baileys Outgoing Media Retry] Attempt to ${jid} failed (${firstErr?.message}), retrying in 1.2s...`);
    await delay(1200);
    const refreshed = activeSessions.get(targetSession.sessionId);
    if (!refreshed || !refreshed.socket || refreshed.status !== 'connected' || !isSocketTrulyOpen(refreshed.socket)) {
      if (!options?.skipLog) {
        addMessageLog({
          wam_id: `baileys_fail_${Date.now()}`,
          session_id: targetSession.sessionId,
          user_id: sessionUserId,
          sender_phone: cleanRecipient,
          sender_name: options?.isBroadcast ? `Broadcast (${cleanRecipient})` : `Tujuan (${cleanRecipient})`,
          message_body: logPreview,
          direction: 'outgoing',
          status: 'Gagal',
          error_detail: firstErr?.message || 'Koneksi terputus saat kirim media'
        });
      }
      throw firstErr;
    }
    targetSession = refreshed;
    try {
      result = await Promise.race([
        targetSession.socket.sendMessage(jid, buildBaileysContent()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Batas waktu kirim ulang media habis (Timeout 28d)')), 28000))
      ]);
    } catch (retryErr: any) {
      if (!options?.skipLog) {
        addMessageLog({
          wam_id: `baileys_fail_${Date.now()}`,
          session_id: targetSession.sessionId,
          user_id: sessionUserId,
          sender_phone: cleanRecipient,
          sender_name: options?.isBroadcast ? `Broadcast (${cleanRecipient})` : `Tujuan (${cleanRecipient})`,
          message_body: logPreview,
          direction: 'outgoing',
          status: 'Gagal',
          error_detail: retryErr?.message || 'Gagal mengirim media/dokumen setelah percobaan ulang'
        });
      }
      throw retryErr;
    }
  }

  if (!options?.skipLog) {
    addMessageLog({
      wam_id: result?.key?.id || `baileys_${Date.now()}`,
      session_id: targetSession.sessionId,
      user_id: sessionUserId,
      sender_phone: cleanRecipient,
      sender_name: options?.isBroadcast ? `Broadcast (${cleanRecipient})` : `Tujuan (${cleanRecipient})`,
      message_body: logPreview,
      direction: 'outgoing',
      status: 'Sukses',
      reply_body: logPreview
    });
  }

  targetSession.lastOutgoingAt = Date.now();

  if (!options?.skipQuota && sessionUserId) {
    deductUserDailyQuota(sessionUserId);
  }

  return {
    success: true,
    wam_id: result?.key?.id,
    to: cleanRecipient,
    session_id: targetSession.sessionId,
    media_type: payload.mediaType,
    raw: result
  };
}

// Send actual outgoing WhatsApp message via connected Baileys socket with strict multi-tenant isolation
export async function sendBaileysTextMessage(
  idOrPhone: string,
  recipientPhone: string,
  text: string,
  options?: { userId?: string; isBroadcast?: boolean; skipLog?: boolean; skipQuota?: boolean; allowAdminFallback?: boolean }
) {
  const cleanRecipient = normalizePhoneNumber(recipientPhone);
  if (!cleanRecipient || cleanRecipient.length < 8) {
    throw new Error(`Nomor WhatsApp tujuan tidak valid (${recipientPhone}).`);
  }

  const jid = `${cleanRecipient}@s.whatsapp.net`;
  let { targetSession, sessionUserId } = await resolveTargetSessionForOutgoing(idOrPhone, options);

  console.log(`[Baileys Outgoing] Sending message to ${jid} via session ${targetSession.sessionId}...`);
  recordBotOutgoing(text);

  let result: any = null;
  try {
    await targetSession.socket.sendPresenceUpdate('composing', jid).catch(() => {});
    await delay(200);
    result = await Promise.race([
      targetSession.socket.sendMessage(jid, { text }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Batas waktu pengiriman ke nomor tujuan habis (Timeout 18d)')), 18000))
    ]);
  } catch (firstErr: any) {
    console.warn(`[Baileys Outgoing Retry] First attempt to ${jid} failed (${firstErr?.message}), retrying in 1.2s...`);
    await delay(1200);
    const refreshed = activeSessions.get(targetSession.sessionId);
    if (!refreshed || !refreshed.socket || refreshed.status !== 'connected' || !isSocketTrulyOpen(refreshed.socket)) {
      if (!options?.skipLog) {
        addMessageLog({
          wam_id: `baileys_fail_${Date.now()}`,
          session_id: targetSession.sessionId,
          user_id: sessionUserId,
          sender_phone: cleanRecipient,
          sender_name: options?.isBroadcast ? `Broadcast (${cleanRecipient})` : `Tujuan (${cleanRecipient})`,
          message_body: text,
          direction: 'outgoing',
          status: 'Gagal',
          error_detail: firstErr?.message || 'Koneksi terputus saat broadcast'
        });
      }
      throw firstErr;
    }
    targetSession = refreshed;
    try {
      result = await Promise.race([
        targetSession.socket.sendMessage(jid, { text }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Batas waktu pengiriman ulang habis (Timeout 18d)')), 18000))
      ]);
    } catch (retryErr: any) {
      if (!options?.skipLog) {
        addMessageLog({
          wam_id: `baileys_fail_${Date.now()}`,
          session_id: targetSession.sessionId,
          user_id: sessionUserId,
          sender_phone: cleanRecipient,
          sender_name: options?.isBroadcast ? `Broadcast (${cleanRecipient})` : `Tujuan (${cleanRecipient})`,
          message_body: text,
          direction: 'outgoing',
          status: 'Gagal',
          error_detail: retryErr?.message || 'Gagal mengirim pesan setelah percobaan ulang'
        });
      }
      throw retryErr;
    }
  }

  if (!options?.skipLog) {
    addMessageLog({
      wam_id: result?.key?.id || `baileys_${Date.now()}`,
      session_id: targetSession.sessionId,
      user_id: sessionUserId,
      sender_phone: cleanRecipient,
      sender_name: options?.isBroadcast ? `Broadcast (${cleanRecipient})` : `Tujuan (${cleanRecipient})`,
      message_body: text,
      direction: 'outgoing',
      status: 'Sukses',
      reply_body: options?.isBroadcast ? 'Dikirim via Broadcast Massal' : text
    });
  }

  targetSession.lastOutgoingAt = Date.now();

  if (!options?.skipQuota && sessionUserId) {
    deductUserDailyQuota(sessionUserId);
  }

  return {
    success: true,
    wam_id: result?.key?.id,
    to: cleanRecipient,
    session_id: targetSession.sessionId,
    raw: result
  };
}

// =========================================================================
// SUPERADMIN WHATSAPP DIRECT DISPATCH + PERSISTENT SLOW QUEUE DRAIN
// =========================================================================
let isDrainingSuperadminQueue = false;

function resolveConnectedSuperadminSession(): SessionState | null {
  const isAdminSession = (s: SessionState) => {
    if (s.status !== 'connected' || !s.socket || !isSocketTrulyOpen(s.socket)) return false;
    const ownerId = s.userId || getSessionById(s.sessionId)?.user_id;
    const owner = ownerId ? getUserById(ownerId) : null;
    return Boolean(owner && owner.role === 'admin' && owner.is_active);
  };

  const candidates = Array.from(activeSessions.values()).filter(isAdminSession);
  if (candidates.length === 0) return null;
  return candidates.find(s => s.is_primary) || candidates[0];
}

async function sendDirectlyViaSuperadminSocket(
  saSession: SessionState,
  recipientPhone: string,
  text: string
): Promise<string | undefined> {
  const cleanRecipient = normalizePhoneNumber(recipientPhone);
  if (!cleanRecipient || cleanRecipient.length < 8) {
    throw new Error(`Nomor WhatsApp tujuan tidak valid (${recipientPhone}).`);
  }
  const jid = `${cleanRecipient}@s.whatsapp.net`;
  recordBotOutgoing(text);

  await saSession.socket.sendPresenceUpdate('composing', jid).catch(() => {});
  await delay(500 + crypto.randomInt(0, 500));
  await saSession.socket.sendPresenceUpdate('paused', jid).catch(() => {});

  const result: any = await Promise.race([
    saSession.socket.sendMessage(jid, { text }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout kirim WA Superadmin (18d)')), 18000)
    )
  ]);
  return result?.key?.id;
}

export async function sendOrQueueViaSuperadminWa(params: {
  recipientPhone: string;
  message: string;
  category: 'order_notification' | 'password_reset' | 'system_otp' | 'session_expired';
  ownerUserId?: string;
  invoiceNumber?: string;
}): Promise<{
  sent: boolean;
  queued: boolean;
  queueId?: string;
  sessionId?: string;
  error?: string;
}> {
  const cleanRecipient = normalizePhoneNumber(params.recipientPhone);
  if (!cleanRecipient || cleanRecipient.length < 8) {
    return {
      sent: false,
      queued: false,
      error: `Nomor WhatsApp tujuan tidak valid (${params.recipientPhone || '-'}).`
    };
  }

  let saSession = resolveConnectedSuperadminSession();

  // If a superadmin session is currently mid-handshake/reconnecting, wait up to 3s once
  if (!saSession) {
    const adminConnecting = Array.from(activeSessions.values()).find(s => {
      if (s.status !== 'connecting') return false;
      const ownerId = s.userId || getSessionById(s.sessionId)?.user_id;
      const owner = ownerId ? getUserById(ownerId) : null;
      return Boolean(owner && owner.role === 'admin' && owner.is_active);
    });
    if (adminConnecting) {
      let tries = 0;
      while (tries < 6 && adminConnecting.status === 'connecting') {
        await delay(500);
        tries++;
      }
      saSession = resolveConnectedSuperadminSession();
    }
  }

  if (saSession) {
    try {
      await sendDirectlyViaSuperadminSocket(saSession, cleanRecipient, params.message);
      console.log(
        `[Superadmin WA Direct] (${params.category}) Sent to ${cleanRecipient} via ${saSession.sessionId}`
      );
      if (params.category === 'order_notification' && params.ownerUserId) {
        addMessageLog({
          wam_id: `sa_ord_${Date.now()}`,
          session_id: saSession.sessionId,
          user_id: params.ownerUserId,
          sender_phone: cleanRecipient,
          sender_name: `Owner Usaha (${cleanRecipient})`,
          message_body: `[Notifikasi Order ${params.invoiceNumber || ''}] Dikirim oleh Superadmin WA`.trim(),
          direction: 'outgoing',
          status: 'Sukses',
          reply_body: params.message.slice(0, 1200)
        });
      }
      return { sent: true, queued: false, sessionId: saSession.sessionId };
    } catch (err: any) {
      console.warn(
        `[Superadmin WA Queue Fallback] Gagal kirim langsung (${params.category}) ke ${cleanRecipient}: ${err?.message}. Memasukkan ke antrean...`
      );
      const queuedEntry = enqueueSuperadminWaMessage({
        recipient_phone: cleanRecipient,
        message: params.message,
        category: params.category,
        owner_user_id: params.ownerUserId,
        invoice_number: params.invoiceNumber,
        last_error: err?.message || 'Gagal kirim langsung'
      });
      return { sent: false, queued: true, queueId: queuedEntry.id, error: err?.message };
    }
  }

  const queuedEntry = enqueueSuperadminWaMessage({
    recipient_phone: cleanRecipient,
    message: params.message,
    category: params.category,
    owner_user_id: params.ownerUserId,
    invoice_number: params.invoiceNumber,
    last_error: 'WhatsApp Superadmin belum terhubung'
  });
  console.log(
    `[Superadmin WA Queued] (${params.category}) Ditambahkan ke antrean untuk ${cleanRecipient} (ID: ${queuedEntry.id})`
  );
  return { sent: false, queued: true, queueId: queuedEntry.id };
}

export async function drainSuperadminWaQueue(
  reason = 'manual'
): Promise<{ processed: number; sent: number; failed: number; remaining: number }> {
  if (isDrainingSuperadminQueue) {
    return { processed: 0, sent: 0, failed: 0, remaining: getSuperadminWaQueue().length };
  }

  const initialQueue = getSuperadminWaQueue();
  if (initialQueue.length === 0) {
    return { processed: 0, sent: 0, failed: 0, remaining: 0 };
  }

  if (!resolveConnectedSuperadminSession()) {
    return { processed: 0, sent: 0, failed: 0, remaining: initialQueue.length };
  }

  isDrainingSuperadminQueue = true;
  let processed = 0;
  let sent = 0;
  let failed = 0;

  try {
    console.log(
      `[Superadmin WA Queue Drain:${reason}] Memproses ${initialQueue.length} pesan antrean secara perlahan (anti-ban)...`
    );

    for (let i = 0; i < initialQueue.length; i++) {
      const item = initialQueue[i];
      const liveSa = resolveConnectedSuperadminSession();
      if (!liveSa) {
        console.warn('[Superadmin WA Queue Drain] Koneksi WA Superadmin terputus saat menguras antrean; sisa pesan ditahan.');
        break;
      }

      processed++;
      try {
        if (item.category === 'session_expired' && item.owner_user_id) {
          const sidFromInvoice = item.invoice_number?.startsWith(`exp_${item.owner_user_id}_`)
            ? item.invoice_number.slice(`exp_${item.owner_user_id}_`.length)
            : '';
          const stateCheck = verifyExpiredAlertState({
            userId: item.owner_user_id,
            sessionId: sidFromInvoice,
            expiredPhone: sidFromInvoice
          });
          if (stateCheck === 'recovered') {
            removeSuperadminWaQueueItem(item.id);
            continue;
          }
          if (stateCheck === 'wait') {
            continue;
          }
        }

        await sendDirectlyViaSuperadminSocket(liveSa, item.recipient_phone, item.message);
        removeSuperadminWaQueueItem(item.id);
        sent++;
        console.log(
          `[Superadmin WA Queue Drain] Terkirim (${i + 1}/${initialQueue.length}) -> ${item.recipient_phone} [${item.category}]`
        );

        if (item.category === 'order_notification' && item.owner_user_id) {
          addMessageLog({
            wam_id: `sa_qord_${Date.now()}`,
            session_id: liveSa.sessionId,
            user_id: item.owner_user_id,
            sender_phone: item.recipient_phone,
            sender_name: `Owner Usaha (${item.recipient_phone})`,
            message_body: `[Notifikasi Order Antrean ${item.invoice_number || ''}] Dikirim oleh Superadmin WA`.trim(),
            direction: 'outgoing',
            status: 'Sukses',
            reply_body: item.message.slice(0, 1200)
          });
        }
      } catch (sendErr: any) {
        failed++;
        const nextAttempts = (item.attempts || 0) + 1;
        if (nextAttempts >= 8) {
          console.warn(
            `[Superadmin WA Queue Drain] Menghapus item antrean ${item.id} setelah ${nextAttempts}x gagal (${sendErr?.message}).`
          );
          removeSuperadminWaQueueItem(item.id);
        } else {
          updateSuperadminWaQueueItem(item.id, {
            attempts: nextAttempts,
            last_error: sendErr?.message || 'Gagal kirim dari antrean'
          });
        }
      }

      // Slow randomized delay (3.5s - 6s) between queued dispatches so Meta won't flag spam
      if (i < initialQueue.length - 1) {
        const slowPaceMs = 3500 + crypto.randomInt(0, 2500);
        await delay(slowPaceMs);
      }
    }
  } finally {
    isDrainingSuperadminQueue = false;
  }

  return {
    processed,
    sent,
    failed,
    remaining: getSuperadminWaQueue().length
  };
}

