import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { supabase } from "../config/supabase.js";
import { createPresignedPutUrl } from "../services/storyVideoDirectUpload.service.js";

const TABLE = "reader_chat_theme_photos";
const PHOTO_FIELDS = "id, title, image_url, created_at";
const INTERNAL_FIELDS =
  "id, reader_id, slot, title, storage_key, image_url, mime_type, file_size, status, expires_at, created_at, completed_at";
const EXTENSIONS = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const windows = new Map();
let client;

function fail(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function owner(req) {
  const id = String(req.user?.user_id || "");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    throw fail(401, "CHAT_THEME_UNAUTHORIZED", "Please sign in again");
  return id;
}

function rate(id, action, maximum, duration = 600000) {
  const now = Date.now();
  const key = `${id}:${action}`;
  if (windows.size >= 5000) {
    for (const [name, state] of windows)
      if (state.until <= now) windows.delete(name);
    if (!windows.has(key) && windows.size >= 5000)
      throw fail(503, "CHAT_THEME_BUSY", "Please try again shortly");
  }
  let state = windows.get(key);
  if (!state || state.until <= now) {
    state = { count: 0, until: now + duration };
    windows.set(key, state);
  }
  if (state.count >= maximum)
    throw fail(429, "CHAT_THEME_RATE_LIMIT", "Please try again shortly");
  state.count += 1;
}

function config() {
  const bucket = String(process.env.R2_BUCKET_NAME || "").trim();
  const account = String(process.env.R2_ACCOUNT_ID || "").trim();
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const publicUrl = String(process.env.R2_PUBLIC_URL || "")
    .trim()
    .replace(/\/+$/, "");
  let valid = false;
  try {
    const url = new URL(publicUrl);
    valid =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {}
  if (!bucket || !account || !accessKeyId || !secretAccessKey || !valid) {
    throw fail(
      503,
      "CHAT_THEME_STORAGE_UNAVAILABLE",
      "Photo storage is temporarily unavailable",
    );
  }
  return { bucket, account, accessKeyId, secretAccessKey, publicUrl };
}

function r2() {
  if (!client) {
    const c = config();
    client = new S3Client({
      region: "auto",
      endpoint: `https://${c.account}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
      },
      maxAttempts: 2,
    });
  }
  return client;
}

function send(command) {
  return r2().send(command, { abortSignal: AbortSignal.timeout(10000) });
}

async function checked(query) {
  const result = await query;
  if (result.error) throw result.error;
  return result.data;
}

function photo(row) {
  return {
    id: row.id,
    title: row.title,
    image_url: row.image_url,
    created_at: row.created_at,
  };
}

function tempPrefix(id) {
  return `media-direct-temp/user/${id}/chat-themes/`;
}

function assertPhotoKey(row) {
  const extension = EXTENSIONS[row.mime_type];
  if (!extension || !UUID.test(row.id))
    throw fail(
      503,
      "CHAT_THEME_STORAGE_INVALID",
      "Photo storage is temporarily unavailable",
    );
  const expected = `${tempPrefix(row.reader_id)}${row.id}.${extension}`;
  const final = new RegExp(
    `^reader-chat-themes/${row.reader_id}/${row.id}/[a-f0-9-]{36}\\.${extension}$`,
  );
  if (row.storage_key !== expected && !final.test(row.storage_key)) {
    throw fail(
      503,
      "CHAT_THEME_STORAGE_INVALID",
      "Photo storage is temporarily unavailable",
    );
  }
}

async function removeObject(key) {
  await send(new DeleteObjectCommand({ Bucket: config().bucket, Key: key }));
}

async function cleanupReservations(id) {
  const rows = await checked(
    supabase.from(TABLE).select(INTERNAL_FIELDS).eq("reader_id", id).limit(10),
  );
  const expired = (rows || []).filter(
    (row) =>
      row.status === "deleting" ||
      (row.status === "pending" && Date.parse(row.expires_at) <= Date.now()),
  );
  const results = await Promise.allSettled(
    expired.map(async (row) => {
      assertPhotoKey(row);
      let marked = row;
      if (row.status !== "deleting") {
        marked = await checked(
          supabase
            .from(TABLE)
            .update({ status: "deleting" })
            .eq("id", row.id)
            .eq("reader_id", id)
            .eq("status", "pending")
            .eq("expires_at", row.expires_at)
            .select(INTERNAL_FIELDS)
            .maybeSingle(),
        );
      }
      if (!marked) return;
      await removeObject(marked.storage_key);
      await checked(
        supabase
          .from(TABLE)
          .delete()
          .eq("id", row.id)
          .eq("reader_id", id)
          .eq("status", "deleting"),
      );
    }),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw fail(
      503,
      "CHAT_THEME_CLEANUP_BUSY",
      "Photo storage is temporarily busy. Please retry",
    );
  }
}

async function cleanupAbandoned(id) {
  const prefix = tempPrefix(id);
  const result = await send(
    new ListObjectsV2Command({
      Bucket: config().bucket,
      Prefix: prefix,
      MaxKeys: 50,
    }),
  );
  const stale = (result.Contents || [])
    .filter(
      (item) =>
        item.Key?.startsWith(prefix) &&
        item.LastModified &&
        Date.now() - new Date(item.LastModified).getTime() > 1800000,
    )
    .slice(0, 10);
  await Promise.allSettled(stale.map((item) => removeObject(item.Key)));
}

function limit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value))
    throw fail(400, "CHAT_THEME_LIMIT_INVALID", "Invalid page size");
  return Math.min(maximum, Math.max(1, Number(value)));
}

function decodeCursor(value) {
  if (value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[a-zA-Z0-9_-]+$/.test(value)
  ) {
    throw fail(400, "CHAT_THEME_CURSOR_INVALID", "Invalid page cursor");
  }
  try {
    const data = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !UUID.test(data.id) ||
      typeof data.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|\+00:00)$/.test(data.at) ||
      !Number.isFinite(Date.parse(data.at))
    )
      throw new Error();
    return data;
  } catch {
    throw fail(400, "CHAT_THEME_CURSOR_INVALID", "Invalid page cursor");
  }
}

export async function listChatThemeBackgrounds(req, res) {
  const id = owner(req);
  rate(id, "read", 120, 60000);
  const size = limit(req.query.limit, 20, 20);
  const cursor = decodeCursor(req.query.cursor);
  let query = supabase
    .from("media_library")
    .select("id, title, image_url, created_at, media_folders!inner(is_active)")
    .eq("chat_theme_enabled", true)
    .eq("is_active", true)
    .eq("media_folders.is_active", true)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(size + 1);
  if (cursor)
    query = query.or(
      `created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`,
    );
  const rows = await checked(query);
  const items = (rows || []).slice(0, size);
  const last = items.at(-1);
  return res.json({
    ok: true,
    items: items.map(photo),
    next_cursor:
      rows?.length > size && last
        ? Buffer.from(
            JSON.stringify({ at: last.created_at, id: last.id }),
          ).toString("base64url")
        : null,
  });
}

export async function listChatThemePhotos(req, res) {
  const id = owner(req);
  rate(id, "read", 120, 60000);
  const size = limit(req.query.limit, 10, 10);
  const rows = await checked(
    supabase
      .from(TABLE)
      .select(PHOTO_FIELDS)
      .eq("reader_id", id)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(size),
  );
  return res.json({ ok: true, items: rows || [], limit: 10 });
}

export async function initiateChatThemePhoto(req, res) {
  const id = owner(req);
  rate(id, "init", 20);
  if (
    String(process.env.MEDIA_DIRECT_UPLOAD_ENABLED || "").toLowerCase() !==
    "true"
  ) {
    throw fail(
      503,
      "CHAT_THEME_UPLOAD_DISABLED",
      "Direct photo upload is not enabled yet",
    );
  }
  config();
  const mime = req.body?.mime_type;
  const extension = EXTENSIONS[mime];
  const size = req.body?.file_size;
  if (!extension)
    throw fail(
      415,
      "CHAT_THEME_TYPE_INVALID",
      "Choose a JPEG, PNG or WebP image",
    );
  if (!Number.isSafeInteger(size) || size < 16 || size > 5242880)
    throw fail(413, "CHAT_THEME_SIZE_INVALID", "Photo must be 5 MB or smaller");
  const title =
    typeof req.body?.title === "string"
      ? req.body.title.trim().slice(0, 120)
      : "";
  await cleanupReservations(id);
  const rows = await checked(
    supabase.from(TABLE).select("slot").eq("reader_id", id).limit(10),
  );
  const occupied = new Set((rows || []).map((row) => row.slot));
  const photoId = randomUUID();
  const key = `${tempPrefix(id)}${photoId}.${extension}`;
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const uploadUrl = createPresignedPutUrl(key, mime, 300, size);
  for (let slot = 1; slot <= 10; slot += 1) {
    if (occupied.has(slot)) continue;
    const result = await supabase.from(TABLE).insert({
      id: photoId,
      reader_id: id,
      slot,
      title,
      storage_key: key,
      mime_type: mime,
      file_size: size,
      status: "pending",
      upload_token_hash: hash,
      expires_at: new Date(Date.now() + 900000).toISOString(),
    });
    if (result.error?.code === "23505") continue;
    if (result.error) throw result.error;
    void cleanupAbandoned(id).catch(() => {});
    return res.status(201).json({
      ok: true,
      upload_url: uploadUrl,
      upload_token: token,
      expires_in_seconds: 300,
      max_bytes: 5242880,
      required_headers: { "Content-Type": mime },
    });
  }
  throw fail(
    409,
    "CHAT_THEME_PHOTO_LIMIT",
    "You can keep up to 10 photos. Delete one or wait for an unfinished upload to expire",
  );
}

async function verifyImage(row) {
  const bucket = config().bucket;
  const head = await send(
    new HeadObjectCommand({ Bucket: bucket, Key: row.storage_key }),
  );
  if (
    Number(head.ContentLength) !== row.file_size ||
    head.ContentType !== row.mime_type ||
    !head.ETag
  ) {
    throw fail(
      400,
      "CHAT_THEME_FILE_MISMATCH",
      "Uploaded photo does not match the selected file",
    );
  }
  const response = await send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: row.storage_key,
      Range: "bytes=0-15",
      IfMatch: head.ETag,
    }),
  );
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  const valid = {
    "image/jpeg":
      bytes.length >= 3 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255,
    "image/png":
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
    "image/webp":
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP",
  }[row.mime_type];
  if (!valid)
    throw fail(
      415,
      "CHAT_THEME_IMAGE_INVALID",
      "Uploaded file is not a supported image",
    );
  return head.ETag;
}

async function findByHash(id, hash) {
  return checked(
    supabase
      .from(TABLE)
      .select(INTERNAL_FIELDS)
      .eq("reader_id", id)
      .eq("upload_token_hash", hash)
      .maybeSingle(),
  );
}

export async function completeChatThemePhoto(req, res) {
  const id = owner(req);
  rate(id, "complete", 60);
  const token = req.body?.upload_token;
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(token))
    throw fail(400, "CHAT_THEME_TOKEN_INVALID", "Upload session is invalid");
  const hash = createHash("sha256").update(token).digest("hex");
  const row = await findByHash(id, hash);
  if (!row || row.status === "deleting")
    throw fail(
      404,
      "CHAT_THEME_UPLOAD_NOT_FOUND",
      "Upload session was not found",
    );
  if (row.status === "ready") return res.json({ ok: true, item: photo(row) });
  if (Date.parse(row.expires_at) <= Date.now())
    throw fail(400, "CHAT_THEME_UPLOAD_EXPIRED", "Upload session has expired");
  assertPhotoKey(row);
  const c = config();
  let etag;
  try {
    etag = await verifyImage(row);
  } catch (error) {
    const current = await findByHash(id, hash);
    if (current?.status === "ready")
      return res.json({ ok: true, item: photo(current) });
    if (
      error?.$metadata?.httpStatusCode === 404 ||
      error?.name === "NotFound" ||
      error?.name === "NoSuchKey"
    ) {
      throw fail(
        400,
        "CHAT_THEME_UPLOAD_MISSING",
        "Upload the photo before applying it",
      );
    }
    throw error;
  }
  const finalKey = `reader-chat-themes/${id}/${row.id}/${randomUUID()}.${EXTENSIONS[row.mime_type]}`;
  await send(
    new CopyObjectCommand({
      Bucket: c.bucket,
      Key: finalKey,
      CopySource: `${encodeURIComponent(c.bucket)}/${row.storage_key.split("/").map(encodeURIComponent).join("/")}`,
      CopySourceIfMatch: etag,
      MetadataDirective: "REPLACE",
      ContentType: row.mime_type,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  const result = await supabase
    .from(TABLE)
    .update({
      storage_key: finalKey,
      image_url: `${c.publicUrl}/${finalKey}`,
      status: "ready",
      completed_at: new Date().toISOString(),
    })
    .eq("reader_id", id)
    .eq("id", row.id)
    .eq("status", "pending")
    .eq("storage_key", row.storage_key)
    .select(INTERNAL_FIELDS)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) {
    await removeObject(finalKey).catch(() => {});
    const current = await findByHash(id, hash);
    if (current?.status === "ready")
      return res.json({ ok: true, item: photo(current) });
    throw fail(
      400,
      "CHAT_THEME_UPLOAD_CHANGED",
      "Upload session is no longer available",
    );
  }
  await removeObject(row.storage_key).catch(() => {});
  return res.status(201).json({ ok: true, item: photo(result.data) });
}

export async function deleteChatThemePhoto(req, res) {
  const id = owner(req);
  rate(id, "delete", 60);
  if (!UUID.test(String(req.params.id || "")))
    throw fail(400, "CHAT_THEME_ID_INVALID", "Invalid photo");
  let row = await checked(
    supabase
      .from(TABLE)
      .select(INTERNAL_FIELDS)
      .eq("id", req.params.id)
      .eq("reader_id", id)
      .maybeSingle(),
  );
  if (!row) return res.json({ ok: true });
  if (row.status === "pending")
    throw fail(
      400,
      "CHAT_THEME_UPLOAD_PENDING",
      "Photo upload is not complete",
    );
  assertPhotoKey(row);
  if (row.status === "ready") {
    row = await checked(
      supabase
        .from(TABLE)
        .update({ status: "deleting" })
        .eq("id", row.id)
        .eq("reader_id", id)
        .eq("status", "ready")
        .select(INTERNAL_FIELDS)
        .maybeSingle(),
    );
    if (!row) return res.json({ ok: true });
  }
  await removeObject(row.storage_key);
  await checked(
    supabase
      .from(TABLE)
      .delete()
      .eq("id", row.id)
      .eq("reader_id", id)
      .eq("status", "deleting"),
  );
  return res.json({ ok: true });
}
