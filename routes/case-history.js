
const express = require("express");

module.exports = function (pool) {
  const router = express.Router();

  // التحقق من تسجيل الدخول
  function requireLogin(req, res, next) {
    if (!req.session || !req.session.officer) {
      return res.status(401).json({
        success: false,
        error: "يجب تسجيل الدخول أولاً."
      });
    }

    next();
  }

  router.use(requireLogin);

  // التحقق من رقم القضية
  function validCaseId(caseId) {
    if (typeof caseId !== "string" || !/^\d+$/.test(caseId)) {
      return false;
    }

    const number = Number(caseId);

    return Number.isSafeInteger(number) && number > 0;
  }

  // التأكد من وجود القضية
  async function caseExists(db, caseId) {
    const result = await db.query(
      `SELECT id
       FROM cases
       WHERE id = $1
       LIMIT 1`,
      [Number(caseId)]
    );

    return result.rows.length > 0;
  }

  // عرض السجل التاريخي للقضية
  router.get("/:caseId", async (req, res) => {
    const { caseId } = req.params;

    if (!validCaseId(caseId)) {
      return res.status(400).json({
        success: false,
        error: "رقم القضية غير صالح."
      });
    }

    try {
      if (!(await caseExists(pool, caseId))) {
        return res.status(404).json({
          success: false,
          error: "القضية غير موجودة."
        });
      }

      const result = await pool.query(
        `SELECT
           ch.*,
           o.username AS officer_username,
           o.full_name AS officer_name,
           o.rank AS officer_rank
         FROM case_history ch
         LEFT JOIN officers o ON o.id = ch.officer_id
         WHERE ch.case_id = $1
         ORDER BY ch.created_at DESC, ch.id DESC`,
        [Number(caseId)]
      );

      return res.json({
        success: true,
        history: result.rows
      });

    } catch (error) {
      console.error("Case history error:", error);

      return res.status(500).json({
        success: false,
        error: "تعذر تحميل سجل القضية."
      });
    }
  });

  // إضافة إجراء إلى السجل التاريخي
  router.post("/:caseId", async (req, res) => {
    const { caseId } = req.params;
    const { action, details } = req.body || {};
    const officerId = req.session.officer.id;

    if (!validCaseId(caseId)) {
      return res.status(400).json({
        success: false,
        error: "رقم القضية غير صالح."
      });
    }

    const allowedActions = [
      "NOTE",
      "UPDATE",
      "STATUS_CHANGE",
      "ASSIGNMENT_CHANGE",
      "REPORT_ADDED",
      "EVIDENCE_ADDED"
    ];

    if (
      typeof action !== "string" ||
      !allowedActions.includes(action)
    ) {
      return res.status(400).json({
        success: false,
        error: "نوع العملية غير صالح."
      });
    }

    if (
      typeof details !== "string" ||
      !details.trim() ||
      details.trim().length > 10000
    ) {
      return res.status(400).json({
        success: false,
        error: "يرجى كتابة التفاصيل، وبحد أقصى 10000 حرف."
      });
    }

    let client;
    let transactionStarted = false;

    try {
      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const jsonDetails = JSON.stringify(details.trim());

      const result = await client.query(
        `INSERT INTO case_history
           (case_id, officer_id, action, details)
         SELECT id, $2, $3, $4::JSONB
         FROM cases
         WHERE id = $1
         RETURNING *`,
        [
          Number(caseId),
          officerId,
          action,
          jsonDetails
        ]
      );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          success: false,
          error: "القضية غير موجودة."
        });
      }

      await client.query(
        `INSERT INTO audit_logs
           (officer_id, action, details)
         VALUES ($1, $2, $3)`,
        [
          officerId,
          "CASE_HISTORY_ADDED",
          `Case ID: ${caseId} | Action: ${action}`
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        success: true,
        message: "تمت إضافة التحديث إلى سجل القضية.",
        history: result.rows[0]
      });

    } catch (error) {
      if (client && transactionStarted) {
        await client.query("ROLLBACK").catch(() => {});
      }

      console.error("Add case history error:", error);

      return res.status(500).json({
        success: false,
        error: "تعذرت إضافة التحديث."
      });

    } finally {
      if (client) {
        client.release();
      }
    }
  });

  // عرض ملاحظات القضية
  router.get("/notes/:caseId", async (req, res) => {
    const { caseId } = req.params;

    if (!validCaseId(caseId)) {
      return res.status(400).json({
        success: false,
        error: "رقم القضية غير صالح."
      });
    }

    try {
      if (!(await caseExists(pool, caseId))) {
        return res.status(404).json({
          success: false,
          error: "القضية غير موجودة."
        });
      }

      const result = await pool.query(
        `SELECT
           n.*,
           o.username AS officer_username,
           o.full_name AS officer_name,
           o.rank AS officer_rank
         FROM case_notes n
         LEFT JOIN officers o ON o.id = n.officer_id
         WHERE n.case_id = $1
         ORDER BY n.created_at DESC, n.id DESC`,
        [Number(caseId)]
      );

      return res.json({
        success: true,
        notes: result.rows
      });

    } catch (error) {
      console.error("Case notes error:", error);

      return res.status(500).json({
        success: false,
        error: "تعذر تحميل ملاحظات القضية."
      });
    }
  });

  // إضافة ملاحظة للقضية
  router.post("/notes/:caseId", async (req, res) => {
    const { caseId } = req.params;

    const note = typeof req.body?.note === "string"
      ? req.body.note.trim()
      : "";

    if (!validCaseId(caseId)) {
      return res.status(400).json({
        success: false,
        error: "رقم القضية غير صالح."
      });
    }

    if (!note || note.length > 10000) {
      return res.status(400).json({
        success: false,
        error: "يرجى كتابة الملاحظة، وبحد أقصى 10000 حرف."
      });
    }

    let client;
    let transactionStarted = false;

    try {
      client = await pool.connect();

      await client.query("BEGIN");
      transactionStarted = true;

      const result = await client.query(
        `INSERT INTO case_notes
           (case_id, officer_id, note)
         SELECT id, $2, $3
         FROM cases
         WHERE id = $1
         RETURNING *`,
        [
          Number(caseId),
          req.session.officer.id,
          note
        ]
      );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          success: false,
          error: "القضية غير موجودة."
        });
      }

      await client.query(
        `INSERT INTO audit_logs
           (officer_id, action, details)
         VALUES ($1, $2, $3)`,
        [
          req.session.officer.id,
          "CASE_NOTE_ADDED",
          `تمت إضافة ملاحظة للقضية رقم ${caseId}`
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        success: true,
        message: "تم حفظ الملاحظة بنجاح.",
        note: result.rows[0]
      });

    } catch (error) {
      if (client && transactionStarted) {
        await client.query("ROLLBACK").catch(() => {});
      }

      console.error("Add case note error:", error);

      return res.status(500).json({
        success: false,
        error: "تعذرت إضافة الملاحظة."
      });

    } finally {
      if (client) {
        client.release();
      }
    }
  });

  return router;
};
