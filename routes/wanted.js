const express = require("express");

module.exports = function (pool) {
  const router = express.Router();

  function requireLogin(req, res, next) {
    if (!req.session || !req.session.officer) {
      return res.status(401).json({
        success: false,
        error: "يجب تسجيل الدخول أولاً"
      });
    }

    next();
  }

  // عرض جميع المطلوبين
  router.get("/", requireLogin, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          w.*,
          o.full_name AS creator_name
        FROM wanted_persons w
        LEFT JOIN officers o ON o.id = w.created_by
        ORDER BY w.created_at DESC
      `);

      res.json({
        success: true,
        wanted: result.rows
      });
    } catch (error) {
      console.error("Wanted GET error:", error);
      res.status(500).json({
        success: false,
        error: "تعذر تحميل قائمة المطلوبين"
      });
    }
  });

  // إضافة مطلوب جديد
  router.post("/", requireLogin, async (req, res) => {
    try {
      const {
        full_name,
        alias,
        description,
        charges,
        threat_level,
        status
      } = req.body;

      if (!full_name || !full_name.trim()) {
        return res.status(400).json({
          success: false,
          error: "اسم المطلوب مطلوب"
        });
      }

      const result = await pool.query(
        `INSERT INTO wanted_persons
        (full_name, alias, description, charges, threat_level, status, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *`,
        [
          full_name.trim(),
          alias || null,
          description || null,
          charges || null,
          threat_level || "Medium",
          status || "Active",
          req.session.officer.id
        ]
      );

      res.status(201).json({
        success: true,
        message: "تم تسجيل المطلوب بنجاح",
        wanted: result.rows[0]
      });

    } catch (error) {
      console.error("Wanted POST error:", error);
      res.status(500).json({
        success: false,
        error: "تعذر تسجيل المطلوب"
      });
    }
  });

  // تعديل بيانات مطلوب
  router.patch("/:id", requireLogin, async (req, res) => {
    try {
      const { id } = req.params;
      const {
        full_name,
        alias,
        description,
        charges,
        threat_level,
        status
      } = req.body;

      if (!full_name || !full_name.trim()) {
        return res.status(400).json({
          success: false,
          error: "اسم المطلوب مطلوب"
        });
      }

      const result = await pool.query(
        `UPDATE wanted_persons
         SET full_name = $1,
             alias = $2,
             description = $3,
             charges = $4,
             threat_level = $5,
             status = $6
         WHERE id = $7
         RETURNING *`,
        [
          full_name.trim(),
          alias || null,
          description || null,
          charges || null,
          threat_level || "Medium",
          status || "Active",
          id
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          error: "المطلوب غير موجود"
        });
      }

      res.json({
        success: true,
        message: "تم تحديث بيانات المطلوب",
        wanted: result.rows[0]
      });

    } catch (error) {
      console.error("Wanted PATCH error:", error);
      res.status(500).json({
        success: false,
        error: "تعذر تحديث بيانات المطلوب"
      });
    }
  });

  return router;
};
