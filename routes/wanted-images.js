
const express = require("express");
const multer = require("multer");

module.exports = function (pool) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
      const allowed = [
        "image/jpeg",
        "image/png",
        "image/webp"
      ];

      if (!allowed.includes(file.mimetype)) {
        return cb(new Error("نوع الصورة غير مدعوم"));
      }

      cb(null, true);
    }
  });

  function requireLogin(req, res, next) {
    if (!req.session || !req.session.officer) {
      return res.status(401).json({
        success: false,
        error: "يجب تسجيل الدخول أولاً"
      });
    }

    next();
  }

  function validId(id) {
    return /^[1-9]\d*$/.test(String(id));
  }

  function handleUpload(req, res, next) {
    upload.single("image")(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.code === "LIMIT_FILE_SIZE"
            ? "حجم الصورة يجب ألا يتجاوز 5 ميجابايت"
            : err.message
        });
      }

      next();
    });
  }

  // عرض صور المطلوب
  router.get("/:wantedId", requireLogin, async (req, res) => {
    try {
      const { wantedId } = req.params;

      if (!validId(wantedId)) {
        return res.status(400).json({
          success: false,
          error: "رقم المطلوب غير صحيح"
        });
      }

      const result = await pool.query(
        `SELECT
          id,
          wanted_id,
          image_name,
          mime_type,
          file_size,
          uploaded_by,
          created_at
        FROM wanted_images
        WHERE wanted_id = $1
        ORDER BY created_at DESC`,
        [wantedId]
      );

      res.json({
        success: true,
        images: result.rows
      });
    } catch (error) {
      console.error("Wanted images error:", error);

      res.status(500).json({
        success: false,
        error: "تعذر جلب الصور"
      });
    }
  });

  // عرض صورة واحدة
  router.get("/file/:imageId", requireLogin, async (req, res) => {
    try {
      const { imageId } = req.params;

      if (!validId(imageId)) {
        return res.status(400).end();
      }

      const result = await pool.query(
        `SELECT image_data, mime_type
         FROM wanted_images
         WHERE id = $1`,
        [imageId]
      );

      if (!result.rows.length) {
        return res.status(404).end();
      }

      const image = result.rows[0];

      res.set("X-Content-Type-Options", "nosniff");
      res.set("Cache-Control", "private, no-store");
      res.type(image.mime_type);
      res.send(image.image_data);
    } catch (error) {
      console.error("Image display error:", error);
      res.status(500).end();
    }
  });

  // رفع صورة لمطلوب
  router.post("/:wantedId", requireLogin, handleUpload, async (req, res) => {
    try {
      const { wantedId } = req.params;

      if (!validId(wantedId)) {
        return res.status(400).json({
          success: false,
          error: "رقم المطلوب غير صحيح"
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "اختر صورة أولاً"
        });
      }

      const wanted = await pool.query(
        "SELECT id FROM wanted_persons WHERE id = $1",
        [wantedId]
      );

      if (!wanted.rows.length) {
        return res.status(404).json({
          success: false,
          error: "المطلوب غير موجود"
        });
      }

      const result = await pool.query(
        `INSERT INTO wanted_images
        (wanted_id, image_name, mime_type, image_data, file_size, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, wanted_id, image_name, mime_type, file_size, created_at`,
        [
          wantedId,
          req.file.originalname,
          req.file.mimetype,
          req.file.buffer,
          req.file.size,
          req.session.officer.id
        ]
      );

      res.status(201).json({
        success: true,
        message: "تم رفع الصورة بنجاح",
        image: result.rows[0]
      });
    } catch (error) {
      console.error("Image upload error:", error);

      res.status(500).json({
        success: false,
        error: "تعذر رفع الصورة"
      });
    }
  });

  return router;
};
