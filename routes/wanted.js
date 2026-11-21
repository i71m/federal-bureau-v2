
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
    return /^[1-9]\d*$/.test(String(id));
  }

  // التحقق من الحقول النصية الاختيارية
  function optionalText(value, maxLength) {
    return value === undefined ||
      value === null ||
      (
        typeof value === "string" &&
        value.trim().length <= maxLength
      );
  }

  // تنظيف الحقول النصية الاختيارية
  function cleanText(value) {
    if (value === undefined || value === null) {
      return null;
    }

    const cleaned = value.trim();
    return cleaned || null;
  }

  // التحقق من بيانات المطلوب
  function validateWanted(body) {
    const {
      full_name,
      alias,
      description,
      charges,
      threat_level,
      status
    } = body || {};

    if (
      typeof full_name !== "string" ||
      !full_name.trim() ||
      full_name.trim().length > 150
    ) {
      return "اسم المطلوب مطلوب، ويجب ألا يتجاوز 150 حرفاً";
    }

    if (!optionalText(alias, 150)) {
      return "الاسم المستعار يجب ألا يتجاوز 150 حرفاً";
    }

    if (!optionalText(description, 10000)) {
      return "الوصف يجب ألا يتجاوز 10000 حرف";
    }

    if (!optionalText(charges, 5000)) {
      return "التهم يجب ألا تتجاوز 5000 حرف";
    }

    const allowedThreatLevels = [
      "Low",
      "Medium",
      "High",
      "Critical",
      "Unknown"
    ];

    const allowedStatuses = [
      "Active",
      "Wanted",
      "Arrested",
      "Cleared"
    ];

    if (
      threat_level !== undefined &&
      threat_level !== null &&
      !allowedThreatLevels.includes(threat_level)
    ) {
      return "مستوى الخطورة غير صالح";
    }

    if (
      status !== undefined &&
      status !== null &&
      !allowedStatuses.includes(status)
    ) {
      return "حالة المطلوب غير صالحة";
    }

    return null;
  }

  // القيم الافتراضية بعد التحقق
  function wantedValues(body) {
    return [
      body.full_name.trim(),
      cleanText(body.alias),
      cleanText(body.description),
      cleanText(body.charges),
      body.threat_level || "Medium",
      body.status || "Active"
    ];
  }

  // تسجيل عملية في السجل العام
  async function addAuditLog(client, officerId, action, details) {
    await client.query(
      `INSERT INTO audit_logs
       (officer_id, action, details)
       VALUES ($1, $2, $3)`,
      [
        officerId,
        action,
        JSON.stringify(details)
      ]
    );
  }

  // تنفيذ المعاملات مع معالجة آمنة للأخطاء
  async function rollback(client) {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      console.error("Wanted ROLLBACK error:", error.message);
    }
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

      return res.json({
        success: true,
        wanted: result.rows
      });

    } catch (error) {
      console.error("Wanted GET error:", error);

      return res.status(500).json({
        success: false,
        error: "تعذر تحميل قائمة المطلوبين"
      });
    }
  });

  // إضافة مطلوب جديد
  router.post("/", requireLogin, async (req, res) => {
    const validationError = validateWanted(req.body);

    if (validationError) {
      return res.status(400).json({
        success: false,
        error: validationError
      });
    }

    let client;

    try {
      client = await pool.connect();

      const values = wantedValues(req.body);

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
          ...values,
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

      await addAuditLog(
        client,
        req.session.officer.id,
        "CREATE_WANTED",
        {
          message: "تم تسجيل مطلوب جديد",
          wanted_id: wanted.id,
          full_name: wanted.full_name,
          alias: wanted.alias
        }
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message: "تم تسجيل المطلوب وحفظ الحدث في سجله",
        wanted
      });

    } catch (error) {
      if (client) await rollback(client);

      console.error("Wanted POST error:", error);

      return res.status(500).json({
        success: false,
        error: "تعذر تسجيل المطلوب"
      });

    } finally {
      if (client) client.release();
    }
  });

  // تعديل بيانات مطلوب
  router.patch("/:id", requireLogin, async (req, res) => {
    const { id } = req.params;

    if (!validId(id)) {
      return res.status(400).json({
        success: false,
        error: "رقم المطلوب غير صالح"
      });
    }

    const validationError = validateWanted(req.body);

    if (validationError) {
      return res.status(400).json({
        success: false,
        error: validationError
      });
    }

    let client;

    try {
      client = await pool.connect();

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
      const values = wantedValues(req.body);

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
        [...values, id]
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

      if (Object.keys(changes).length > 0) {
        const action =
          oldWanted.status !== updatedWanted.status
            ? "STATUS_CHANGE"
            : "UPDATE";

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

        await addAuditLog(
          client,
          req.session.officer.id,
          "UPDATE_WANTED",
          {
            message: "تم تحديث بيانات مطلوب",
            wanted_id: updatedWanted.id,
            full_name: updatedWanted.full_name,
            changes
          }
        );
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "تم تحديث بيانات المطلوب وحفظ سجل التغييرات",
        wanted: updatedWanted
      });

    } catch (error) {
      if (client) await rollback(client);

      console.error("Wanted PATCH error:", error);

      return res.status(500).json({
        success: false,
        error: "تعذر تحديث بيانات المطلوب"
      });

    } finally {
      if (client) client.release();
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

    let client;

    try {
      client = await pool.connect();

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

      await client.query(
        "DELETE FROM wanted_images WHERE wanted_id = $1",
        [id]
      );

      await client.query(
        "DELETE FROM wanted_history WHERE wanted_id = $1",
        [id]
      );

      await client.query(
        "DELETE FROM wanted_persons WHERE id = $1",
        [id]
      );

      await addAuditLog(
        client,
        req.session.officer.id,
        "DELETE_WANTED",
        {
          message: "تم حذف ملف مطلوب نهائياً",
          wanted_id: wanted.id,
          full_name: wanted.full_name,
          alias: wanted.alias
        }
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "تم حذف ملف المطلوب وصوره وسجله التاريخي نهائياً"
      });

    } catch (error) {
      if (client) await rollback(client);

      console.error("Wanted DELETE error:", error);

      return res.status(500).json({
        success: false,
        error: "تعذر حذف ملف المطلوب"
      });

    } finally {
      if (client) client.release();
    }
  });

  return router;
};
