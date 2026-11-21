
const express = require("express");
const multer = require("multer");

module.exports = function (pool) {
  const router = express.Router();

  const MAX_FILE_SIZE = 5 * 1024 * 1024;

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 1
    },
    fileFilter: (req, file, cb) => {
      if (!allowedTypes.includes(file.mimetype)) {
        return cb(new Error("نوع الصورة غير مدعوم"));
      }

      cb(null, true);
    }
  });

  // التحقق من تسجيل الدخول
  function requireLogin(req, res, next) {
    if (!req.session || !req.session.officer) {
      return res.status(401).json({
        success: false,
        error: "يجب تسجيل الدخول أولاً"
      });
    }

    next();
  }

  // التحقق من الرقم
  function validId(id) {
    return /^[1-9]\d*$/.test(String(id));
  }

  // التحقق من نوع الصورة الحقيقي
  function detectImageType(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      return null;
    }

    // JPEG
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xFF &&
      buffer[1] === 0xD8 &&
      buffer[2] === 0xFF
    ) {
      return "image/jpeg";
    }

    // PNG
    const pngSignature = Buffer.from([
      0x89, 0x50, 0x4E, 0x47,
      0x0D, 0x0A, 0x1A, 0x0A
    ]);

    if (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(pngSignature)
    ) {
      return "image/png";
    }

    // WEBP
    if (
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
      return "image/webp";
    }

    return null;
  }

  // تنظيف اسم الصورة
  function cleanImageName(name) {
    const cleaned = String(name || "")
      .replace(/[\/\\]/g, "_")
      .replace(/[\x00-\x1F\x7F]/g, "")
      .trim()
      .slice(0, 200);

    return cleaned || "wanted-image";
  }

  // معالجة رفع الصورة
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

  // التراجع عن المعاملة بأمان
  async function rollback(client) {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      console.error("Wanted images ROLLBACK error:", error.message);
    }
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

      return res.json({
        success: true,
        images: result.rows
      });

    } catch (error) {
      console.error("Wanted images GET error:", error);

      return res.status(500).json({
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

      if (!allowedTypes.includes(image.mime_type)) {
        return res.status(415).end();
      }

      res.set("X-Content-Type-Options", "nosniff");
      res.set("Cache-Control", "private, no-store");
      res.set("Content-Type", image.mime_type);

      return res.send(image.image_data);

    } catch (error) {
      console.error("Wanted image display error:", error);
      return res.status(500).end();
    }
  });

  // رفع صورة لمطلوب
  router.post(
    "/:wantedId",
    requireLogin,
    (req, res, next) => {
      if (!validId(req.params.wantedId)) {
        return res.status(400).json({
          success: false,
          error: "رقم المطلوب غير صحيح"
        });
      }

      next();
    },
    handleUpload,
    async (req, res) => {
      let client;

      try {
        const { wantedId } = req.params;

        if (!req.file) {
          return res.status(400).json({
            success: false,
            error: "اختر صورة أولاً"
          });
        }

        // فحص محتوى الصورة الحقيقي
        const detectedType = detectImageType(req.file.buffer);

        if (!detectedType || detectedType !== req.file.mimetype) {
          return res.status(400).json({
            success: false,
            error: "محتوى الصورة غير صالح أو نوع الملف غير مطابق"
          });
        }

        const imageName = cleanImageName(req.file.originalname);

        client = await pool.connect();

        await client.query("BEGIN");

        // التأكد من وجود المطلوب
        const wanted = await client.query(
          "SELECT id FROM wanted_persons WHERE id = $1",
          [wantedId]
        );

        if (!wanted.rows.length) {
          await rollback(client);

          return res.status(404).json({
            success: false,
            error: "المطلوب غير موجود"
          });
        }

        // حفظ الصورة
        const result = await client.query(
          `INSERT INTO wanted_images
          (
            wanted_id,
            image_name,
            mime_type,
            image_data,
            file_size,
            uploaded_by
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING
            id,
            wanted_id,
            image_name,
            mime_type,
            file_size,
            created_at`,
          [
            wantedId,
            imageName,
            detectedType,
            req.file.buffer,
            req.file.size,
            req.session.officer.id
          ]
        );

        const image = result.rows[0];

        // تسجيل العملية
        await client.query(
          `INSERT INTO audit_logs
          (officer_id, action, details)
          VALUES ($1, $2, $3)`,
          [
            req.session.officer.id,
            "UPLOAD_WANTED_IMAGE",
            JSON.stringify({
              message: "تم رفع صورة لملف مطلوب",
              wanted_id: wantedId,
              image_id: image.id,
              image_name: image.image_name,
              mime_type: image.mime_type,
              file_size: image.file_size
            })
          ]
        );

        await client.query("COMMIT");

        return res.status(201).json({
          success: true,
          message: "تم رفع الصورة بنجاح",
          image
        });

      } catch (error) {
        if (client) {
          await rollback(client);
        }

        console.error("Wanted image upload error:", error);

        return res.status(500).json({
          success: false,
          error: "تعذر رفع الصورة"
        });

      } finally {
        if (client) {
          client.release();
        }
      }
    }
  );

  return router;
};
