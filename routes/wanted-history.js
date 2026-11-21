
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

  router.use(requireLogin);

  // التحقق من رقم المطلوب
  function validWantedId(id) {
    const number = Number(id);

    return Number.isSafeInteger(number) && number > 0;
  }

  // جلب سجل تاريخ المطلوب
  router.get("/:wantedId", async (req, res) => {
    try {
      const wantedId = req.params.wantedId;

      if (!validWantedId(wantedId)) {
        return res.status(400).json({
          success: false,
          error: "رقم المطلوب غير صحيح"
        });
      }

      // التأكد من وجود المطلوب
      const wanted = await pool.query(
        `SELECT id
         FROM wanted_persons
         WHERE id = $1
         LIMIT 1`,
        [Number(wantedId)]
      );

      if (wanted.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "المطلوب غير موجود"
        });
      }

      // جلب السجل مع بيانات الضابط
      const result = await pool.query(
        `SELECT
           wh.id,
           wh.wanted_id,
           wh.officer_id,
           wh.action,
           wh.details,
           wh.created_at,
           o.full_name AS officer_name,
           o.rank AS officer_rank
         FROM wanted_history wh
         LEFT JOIN officers o
           ON o.id = wh.officer_id
         WHERE wh.wanted_id = $1
         ORDER BY wh.created_at DESC, wh.id DESC`,
        [Number(wantedId)]
      );

      return res.json({
        success: true,
        history: result.rows
      });

    } catch (error) {
      console.error("Wanted history error:", error);

      return res.status(500).json({
        success: false,
        error: "حدث خطأ أثناء جلب سجل المطلوب"
      });
    }
  });

  return router;
};
