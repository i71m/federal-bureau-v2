
const express = require("express");

module.exports = function (pool) {
  const router = express.Router();

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

  // التحقق من رقم المطلوب
  function validId(id) {
    return /^[1-9]\d*$/.test(id);
  }

  // عرض سجل مطلوب محدد
  router.get("/:wantedId", requireLogin, async (req, res) => {
    try {
      const { wantedId } = req.params;

      if (!validId(wantedId)) {
        return res.status(400).json({
          success: false,
          error: "رقم المطلوب غير صالح"
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
        `SELECT
           h.id,
           h.wanted_id,
           h.action,
           h.details,
           h.created_at,
           o.full_name AS officer_name,
           o.rank AS officer_rank
         FROM wanted_history h
         LEFT JOIN officers o ON o.id = h.officer_id
         WHERE h.wanted_id = $1
         ORDER BY h.created_at DESC`,
        [wantedId]
      );

      res.json({
        success: true,
        history: result.rows
      });

    } catch (error) {
      console.error("Wanted history GET error:", error);

      res.status(500).json({
        success: false,
        error: "تعذر تحميل سجل المطلوب"
      });
    }
  });

  // إضافة حدث إلى سجل المطلوب
  router.post("/:wantedId", requireLogin, async (req, res) => {
    try {
      const { wantedId } = req.params;
      const { action, details } = req.body;

      if (!validId(wantedId)) {
        return res.status(400).json({
          success: false,
          error: "رقم المطلوب غير صالح"
        });
      }

      const allowedActions = [
        "CREATE",
        "UPDATE",
        "STATUS_CHANGE",
        "NOTE"
      ];

      if (!allowedActions.includes(action)) {
        return res.status(400).json({
          success: false,
          error: "نوع الإجراء غير صالح"
        });
      }

      if (
        typeof details !== "string" ||
        !details.trim() ||
        details.trim().length > 5000
      ) {
        return res.status(400).json({
          success: false,
          error: "تفاصيل الإجراء مطلوبة وبحد أقصى 5000 حرف"
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
        `INSERT INTO wanted_history
         (wanted_id, officer_id, action, details)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          wantedId,
          req.session.officer.id,
          action,
          details.trim()
        ]
      );

      res.status(201).json({
        success: true,
        message: "تم تسجيل الحدث في سجل المطلوب",
        history: result.rows[0]
      });

    } catch (error) {
      console.error("Wanted history POST error:", error);

      res.status(500).json({
        success: false,
        error: "تعذر تسجيل الحدث"
      });
    }
  });

  return router;
};
