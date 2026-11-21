const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authorize, isDirector, hasMinimumRank } = require("../middleware/permissions");

function requireLogin(req, res, next) {
  if (!req.session?.officer) {
    return res.status(401).json({
      success: false,
      error: "يجب تسجيل الدخول أولاً."
    });
  }
  next();
}

// عرض طلبات حذف القضايا
router.get("/", requireLogin, authorize("Agent 5"), async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT r.*, 
             o.full_name AS requester_name,
             a.full_name AS reviewer_name
      FROM case_deletion_requests r
      LEFT JOIN officers o ON o.id = r.requested_by
      LEFT JOIN officers a ON a.id = r.reviewed_by
      ORDER BY r.created_at DESC
    `);

    res.json({ success: true, requests: result.rows });
  } catch (error) {
    next(error);
  }
});

// تقديم طلب حذف قضية
router.post("/:caseId", requireLogin, authorize("Agent 7"), async (req, res, next) => {
  const client = await pool.connect();

  try {
    const caseId = Number(req.params.caseId);

    if (!Number.isInteger(caseId) || caseId <= 0) {
      return res.status(400).json({
        success: false,
        error: "رقم القضية غير صحيح."
      });
    }

    const existingCase = await client.query(
      "SELECT id, case_number, title FROM cases WHERE id = $1",
      [caseId]
    );

    if (!existingCase.rowCount) {
      return res.status(404).json({
        success: false,
        error: "القضية غير موجودة."
      });
    }

    const pending = await client.query(
      `SELECT id FROM case_deletion_requests
       WHERE case_id = $1 AND status = 'pending'`,
      [caseId]
    );

    if (pending.rowCount) {
      return res.status(409).json({
        success: false,
        error: "يوجد طلب حذف قيد المراجعة لهذه القضية."
      });
    }

    const result = await client.query(
      `INSERT INTO case_deletion_requests
       (case_id, requested_by, reason, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [
        caseId,
        req.session.officer.id,
        String(req.body.reason || "").trim()
      ]
    );

    res.status(201).json({
      success: true,
      message: "تم تقديم طلب حذف القضية للمراجعة.",
      request: result.rows[0]
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

// اعتماد أو رفض طلب الحذف
router.patch("/:requestId/review", requireLogin, authorize("Agent 5"), async (req, res, next) => {
  const client = await pool.connect();

  try {
    const requestId = Number(req.params.requestId);
    const decision = String(req.body.decision || "").toLowerCase();

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({
        success: false,
        error: "رقم الطلب غير صحيح."
      });
    }

    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({
        success: false,
        error: "القرار يجب أن يكون approve أو reject."
      });
    }

    await client.query("BEGIN");

    const requestResult = await client.query(
      `SELECT * FROM case_deletion_requests
       WHERE id = $1 AND status = 'pending'
       FOR UPDATE`,
      [requestId]
    );

    if (!requestResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: "الطلب غير موجود أو تمت مراجعته مسبقاً."
      });
    }

    const deletionRequest = requestResult.rows[0];

    if (decision === "approve") {
      await client.query(
        "DELETE FROM cases WHERE id = $1",
        [deletionRequest.case_id]
      );
    }

    const updated = await client.query(
      `UPDATE case_deletion_requests
       SET status = $1,
           reviewed_by = $2,
           reviewed_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [
        decision === "approve" ? "approved" : "rejected",
        req.session.officer.id,
        requestId
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: decision === "approve"
        ? "تم اعتماد طلب الحذف."
        : "تم رفض طلب الحذف.",
      request: updated.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
