import express from "express";
import { requireUser } from "../middleware/user.middleware.js";
import {
  listChatThemeBackgrounds,
  listChatThemePhotos,
  initiateChatThemePhoto,
  completeChatThemePhoto,
  deleteChatThemePhoto,
} from "../controllers/readerChatThemes.controller.js";

const router = express.Router();

router.use(requireUser);
router.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

function handle(handler) {
  return (req, res) =>
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        const safe =
          Number.isInteger(error?.statusCode) &&
          error.statusCode >= 400 &&
          error.statusCode <= 599;
        if (!safe)
          console.error("CHAT_THEME_API_ERROR", {
            code: error?.code || "UNKNOWN",
          });
        if (res.headersSent) return;
        res.status(safe ? error.statusCode : 503).json({
          ok: false,
          code: safe ? error.code : "CHAT_THEME_UNAVAILABLE",
          message: safe
            ? error.message
            : "Chat themes are temporarily unavailable",
        });
      });
}

router.get("/backgrounds", handle(listChatThemeBackgrounds));
router.get("/photos", handle(listChatThemePhotos));
router.post("/photos/init", handle(initiateChatThemePhoto));
router.post("/photos/complete", handle(completeChatThemePhoto));
router.delete("/photos/:id", handle(deleteChatThemePhoto));

export default router;
