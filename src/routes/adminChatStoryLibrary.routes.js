import express from "express";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { supabase } from "../config/supabase.js";
import { requireAdminPermission } from "../middleware/adminPermission.middleware.js";
import {
  assertR2MediaReference,
  assertR2StorageKey,
} from "../services/mediaStoragePolicy.service.js";

const router = express.Router();
const FOLDER_ID = "9a98ad91-bc5a-4a1f-8c82-9f335ecd9716";
const FIELDS = "id, title, image_url, is_active, created_at";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
let client;

function fail(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function checked(query) {
  const result = await query;
  if (result.error) throw result.error;
  return result.data;
}

function handle(fn) {
  return (req, res) =>
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((error) => {
        const safe =
          Number.isInteger(error.statusCode) &&
          error.statusCode >= 400 &&
          error.statusCode <= 599;
        if (!safe)
          console.error("ADMIN_CHAT_LIBRARY_ERROR", {
            code: error.code || "UNKNOWN",
          });
        if (!res.headersSent)
          res.status(safe ? error.statusCode : 503).json({
            ok: false,
            message: safe
              ? error.message
              : "Chat Story Library is temporarily unavailable",
          });
      });
}

function validId(value) {
  if (!UUID.test(String(value || ""))) throw fail(400, "Invalid background ID");
  return value;
}

function title(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 120)
    throw fail(400, "Enter a title of 1 to 120 characters");
  return result;
}

async function ensureFolder() {
  await checked(
    supabase.from("media_folders").upsert(
      {
        id: FOLDER_ID,
        name: "Chat Story Library",
        icon: "🌙",
        description: "Portrait backgrounds for Chat Story themes",
        sort_order: 0,
        is_active: true,
      },
      { onConflict: "id", ignoreDuplicates: true },
    ),
  );
  const folder = await checked(
    supabase
      .from("media_folders")
      .select("id, is_active")
      .eq("id", FOLDER_ID)
      .maybeSingle(),
  );
  if (!folder?.is_active)
    throw fail(
      400,
      "Enable the Chat Story Library folder in Media Library first",
    );
}

async function verifyReference(imageUrl, key) {
  const bucket = String(process.env.R2_BUCKET_NAME || "").trim();
  const account = String(process.env.R2_ACCOUNT_ID || "").trim();
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const publicUrl = String(process.env.R2_PUBLIC_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!bucket || !account || !accessKeyId || !secretAccessKey || !publicUrl)
    throw fail(503, "Photo storage is temporarily unavailable");
  if (
    !key.startsWith("admin-media-library/images/") &&
    !key.startsWith("media-library/images/")
  )
    throw fail(400, "Choose an image uploaded to Media Library");
  if (imageUrl !== `${publicUrl}/${key}`)
    throw fail(400, "Image URL does not match its storage key");
  if (!client)
    client = new S3Client({
      region: "auto",
      endpoint: `https://${account}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 2,
    });
  let head;
  try {
    head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(10000) },
    );
  } catch (error) {
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404)
      throw fail(400, "Uploaded image was not found");
    throw error;
  }
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(head.ContentType) ||
    !(head.ContentLength > 0 && head.ContentLength <= 5242880)
  ) {
    throw fail(400, "Choose a JPEG, PNG or WebP image up to 5 MB");
  }
}

router.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

router.get(
  "/",
  requireAdminPermission("media_library.view"),
  handle(async (req, res) => {
    const rawPage = req.query.page ?? "1";
    if (typeof rawPage !== "string" || !/^\d{1,5}$/.test(rawPage))
      throw fail(400, "Invalid page");
    const page = Number(rawPage);
    if (page < 1 || page > 10000) throw fail(400, "Invalid page");
    const q = req.query.q ?? "";
    const status = req.query.status ?? "all";
    if (
      typeof q !== "string" ||
      q.length > 80 ||
      !["all", "visible", "hidden"].includes(status)
    )
      throw fail(400, "Invalid search or filter");
    let query = supabase
      .from("media_library")
      .select(FIELDS)
      .eq("chat_theme_enabled", true)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range((page - 1) * 10, page * 10);
    if (status !== "all") query = query.eq("is_active", status === "visible");
    if (q.trim())
      query = query.ilike("title", `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`);
    const rows = await checked(query);
    res.json({
      ok: true,
      items: (rows || []).slice(0, 10),
      page,
      limit: 10,
      has_more: rows?.length > 10,
    });
  }),
);

router.post(
  "/",
  requireAdminPermission("media_library.manage"),
  handle(async (req, res) => {
    const id = validId(req.body?.id);
    const name = title(req.body?.title);
    const imageUrl = assertR2MediaReference(req.body?.image_url, {
      allowEmpty: false,
    });
    const key = assertR2StorageKey(req.body?.storage_key, {
      allowEmpty: false,
    });
    if (typeof req.body?.is_active !== "boolean")
      throw fail(400, "Choose background visibility");
    const existing = await checked(
      supabase
        .from("media_library")
        .select(`${FIELDS}, storage_key, chat_theme_enabled`)
        .eq("id", id)
        .maybeSingle(),
    );
    if (existing) {
      if (
        existing.storage_key !== key ||
        existing.image_url !== imageUrl ||
        !existing.chat_theme_enabled
      )
        throw fail(409, "Background ID is already in use");
      return res.json({
        ok: true,
        item: Object.fromEntries(
          FIELDS.split(", ").map((field) => [field, existing[field]]),
        ),
      });
    }
    await verifyReference(imageUrl, key);
    await ensureFolder();
    const result = await supabase
      .from("media_library")
      .insert({
        id,
        folder_id: FOLDER_ID,
        title: name,
        alt_text: name,
        image_url: imageUrl,
        storage_key: key,
        media_type: "image",
        tags: ["chat-story-background"],
        sort_order: 0,
        is_active: req.body.is_active,
        chat_theme_enabled: true,
        updated_at: new Date().toISOString(),
      })
      .select(FIELDS)
      .single();
    if (result.error?.code === "23505") {
      const item = await checked(
        supabase
          .from("media_library")
          .select(`${FIELDS}, storage_key, chat_theme_enabled`)
          .eq("id", id)
          .maybeSingle(),
      );
      if (
        item?.storage_key === key &&
        item?.image_url === imageUrl &&
        item?.chat_theme_enabled
      ) {
        return res.json({
          ok: true,
          item: Object.fromEntries(
            FIELDS.split(", ").map((field) => [field, item[field]]),
          ),
        });
      }
    }
    if (result.error) throw result.error;
    res.status(201).json({ ok: true, item: result.data });
  }),
);

router.patch(
  "/:id",
  requireAdminPermission("media_library.manage"),
  handle(async (req, res) => {
    const id = validId(req.params.id);
    const patch = { updated_at: new Date().toISOString() };
    if (Object.hasOwn(req.body || {}, "title")) {
      patch.title = title(req.body.title);
      patch.alt_text = patch.title;
    }
    if (Object.hasOwn(req.body || {}, "is_active")) {
      if (typeof req.body.is_active !== "boolean")
        throw fail(400, "Choose background visibility");
      patch.is_active = req.body.is_active;
    }
    if (Object.keys(patch).length === 1) throw fail(400, "No changes to save");
    const item = await checked(
      supabase
        .from("media_library")
        .update(patch)
        .eq("id", id)
        .eq("chat_theme_enabled", true)
        .select(FIELDS)
        .maybeSingle(),
    );
    if (!item) throw fail(404, "Background was not found");
    res.json({ ok: true, item });
  }),
);

router.delete(
  "/:id",
  requireAdminPermission("media_library.manage"),
  handle(async (req, res) => {
    const id = validId(req.params.id);
    await checked(
      supabase
        .from("media_library")
        .update({
          chat_theme_enabled: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("chat_theme_enabled", true),
    );
    res.json({ ok: true });
  }),
);

export default router;
