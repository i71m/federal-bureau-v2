
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

  // إضافة مطلوب جديد مع تسجيل الحدث
  router.post("/", requireLogin, async (req, res) => {
    const client = await pool.connect();

    try {
      const {
        full_name,
        alias,
        description,
        charges,
        threat_level,
        status
      } = req.body;

      if (
        typeof full_name !== "string" ||
        !full_name.trim()
      ) {
        return res.status(400).json({
          success: false,
          error: "اسم المطلوب مطلوب"
        });
      }

      await client.query("BEGIN");

      const result = await client.query(
        `INSERT INTO wanted_persons
        (
          full_name,
          alias,
          description,
          charges,
          threat_level,
          status,
          created_by
        )
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

      const wanted = result.rows[0];

      await client.query(
        `INSERT INTO wanted_history
        (wanted_id, officer_id, action, details)
        VALUES ($1, $2, $3, $4)`,
        [
          wanted.id,
          req.session.officer.id,
          "CREATE",
          JSON.stringify({
            message: "تم تسجيل مطلوب جديد",
            full_name: wanted.full_name,
            alias: wanted.alias,
            threat_level: wanted.threat_level,
            status: wanted.status
          })
        ]
      );

      await client.query("COMMIT");

      res.status(201).json({
        success: true,
        message: "تم تسجيل المطلوب وحفظ الحدث في سجله",
        wanted
      });

    } catch (error) {
      await client.query("ROLLBACK");

      console.error("Wanted POST error:", error);

      res.status(500).json({
        success: false,
        error: "تعذر تسجيل المطلوب"
      });

    } finally {
      client.release();
    }
  });

  // تعديل بيانات مطلوب مع تسجيل التغييرات
  router.patch("/:id", requireLogin, async (req, res) => {
    const client = await pool.connect();

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

      if (!validId(id)) {
        return res.status(400).json({
          success: false,
          error: "رقم المطلوب غير صالح"
        });
      }

      if (
        typeof full_name !== "string" ||
        !full_name.trim()
      ) {
        return res.status(400).json({
          success: false,
          error: "اسم المطلوب مطلوب"
        });
      }

      await client.query("BEGIN");

      const oldResult = await client.query(
        `SELECT *
         FROM wanted_persons
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );

      if (!oldResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          error: "المطلوب غير موجود"
        });
      }

      const oldWanted = oldResult.rows[0];

      const result = await client.query(
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

      const updatedWanted = result.rows[0];

      const changes = {};

      const fields = [
        "full_name",
        "alias",
        "description",
        "charges",
        "threat_level",
        "status"
      ];

      for (const field of fields) {
        const oldValue = oldWanted[field] ?? null;
        const newValue = updatedWanted[field] ?? null;

        if (oldValue !== newValue) {
          changes[field] = {
            before: oldValue,
            after: newValue
          };
        }
      }

      const action =
        oldWanted.status !== updatedWanted.status
          ? "STATUS_CHANGE"
          : "UPDATE";

      if (Object.keys(changes).length > 0) {
        await client.query(
          `INSERT INTO wanted_history
          (wanted_id, officer_id, action, details)
          VALUES ($1, $2, $3, $4)`,
          [
            id,
            req.session.officer.id,
            action,
            JSON.stringify({
              message: "تم تحديث بيانات المطلوب",
              changes
            })
          ]
        );
      }

      await client.query("COMMIT");

      res.json({
        success: true,
        message: "تم تحديث بيانات المطلوب وحفظ سجل التغييرات",
        wanted: updatedWanted
      });

    } catch (error) {
      await client.query("ROLLBACK");

      console.error("Wanted PATCH error:", error);

      res.status(500).json({
        success: false,
        error: "تعذر تحديث بيانات المطلوب"
      });

    } finally {
      client.release();
    }
  });

  // الحذف النهائي للمطلوب - المدير فقط
  router.delete("/:id", requireLogin, async (req, res) => {
    const isAdmin =
      String(req.session.officer.role || "").toLowerCase() === "admin";

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: "هذه العملية متاحة للمدير فقط"
      });
    }

    const { id } = req.params;

    if (!validId(id)) {
      return res.status(400).json({
        success: false,
        error: "رقم المطلوب غير صالح"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT *
         FROM wanted_persons
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );

      if (!result.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          error: "المطلوب غير موجود"
        });
      }

      const wanted = result.rows[0];

      // حذف الصور والسجل التاريخي المرتبطين بالملف
      await client.query(
        "DELETE FROM wanted_images WHERE wanted_id = $1",
        [id]
      );

      await client.query(
        "DELETE FROM wanted_history WHERE wanted_id = $1",
        [id]
      );

      // حذف ملف المطلوب نهائياً
      await client.query(
        "DELETE FROM wanted_persons WHERE id = $1",
        [id]
      );

      // الاحتفاظ بأثر عملية الحذف في سجل العمليات العام
      await client.query(
        `INSERT INTO audit_logs
        (officer_id, action, details)
        VALUES ($1, $2, $3)`,
        [
          req.session.officer.id,
          "DELETE_WANTED",
          JSON.stringify({
            message: "تم حذف ملف مطلوب نهائياً",
            wanted_id: wanted.id,
            full_name: wanted.full_name,
            alias: wanted.alias
          })
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message: "تم حذف ملف المطلوب وصوره وسجله التاريخي نهائياً"
      });

    } catch (error) {
      await client.query("ROLLBACK");

      console.error("Wanted DELETE error:", error);

      res.status(500).json({
        success: false,
        error: "تعذر حذف ملف المطلوب"
      });

    } finally {
      client.release();
    }
  });

  return router;
};
