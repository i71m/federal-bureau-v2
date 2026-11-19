
const express = require("express");
const router = express.Router();
const pool = require("../db");

function requireLogin(req, res, next) {
  if (!req.session || !req.session.officer) {
    return res.status(401).json({
      success: false,
      message: "يجب تسجيل الدخول أولاً"
    });
  }
  next();
}

router.use(requireLogin);

// عرض جميع القضايا
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.*,
        o.full_name AS created_by_name
      FROM cases c
      LEFT JOIN officers o ON o.id = c.created_by
      ORDER BY c.created_at DESC
    `);

    res.json({
      success: true,
      cases: result.rows
    });
  } catch (error) {
    console.error("Cases error:", error);
    res.status(500).json({
      success: false,
      message: "تعذر تحميل القضايا"
    });
  }
});

// إنشاء قضية جديدة
router.post("/", async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      status,
      secrecy_level
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: "عنوان القضية مطلوب"
      });
    }

    const allowedStatuses = [
      "مفتوحة",
      "قيد التحقيق",
      "مغلقة"
    ];

    const allowedSecrecy = [
      "عادي",
      "سري",
      "سري للغاية"
    ];

    const caseStatus = allowedStatuses.includes(status)
      ? status
      : "مفتوحة";

    const secrecy = allowedSecrecy.includes(secrecy_level)
      ? secrecy_level
      : "عادي";

    const result = await pool.query(
      `INSERT INTO cases
       (title, description, category, status, secrecy_level, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        title.trim(),
        description || "",
        category || "عام",
        caseStatus,
        secrecy,
        req.session.officer.id
      ]
    );

    res.status(201).json({
      success: true,
      message: "تم إنشاء القضية بنجاح",
      case: result.rows[0]
    });
  } catch (error) {
    console.error("Create case error:", error);
    res.status(500).json({
      success: false,
      message: "تعذر إنشاء القضية"
    });
  }
});

// تحديث بيانات القضية
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      category,
      status,
      secrecy_level
    } = req.body;

    const result = await pool.query(
      `UPDATE cases
       SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         category = COALESCE($3, category),
         status = COALESCE($4, status),
         secrecy_level = COALESCE($5, secrecy_level)
       WHERE id = $6
       RETURNING *`,
      [
        title,
        description,
        category,
        status,
        secrecy_level,
        id
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "القضية غير موجودة"
      });
    }

    res.json({
      success: true,
      message: "تم تحديث القضية",
      case: result.rows[0]
    });
  } catch (error) {
    console.error("Update case error:", error);
    res.status(500).json({
      success: false,
      message: "تعذر تحديث القضية"
    });
  }
});

// حذف قضية
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "DELETE FROM cases WHERE id = $1 RETURNING id",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "القضية غير موجودة"
      });
    }

    res.json({
      success: true,
      message: "تم حذف القضية"
    });
  } catch (error) {
    console.error("Delete case error:", error);
    res.status(500).json({
      success: false,
      message: "تعذر حذف القضية"
    });
  }
});

module.exports = router;
