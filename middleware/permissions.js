const RANKS = {
  "Agent 0": 0,
  "Agent 1": 1,
  "Agent 2": 2,
  "Agent 3": 3,
  "Agent 4": 4,
  "Agent 5": 5,
  "Agent 6": 6,
  "Agent 7": 7,
  "Agent 8": 8,
  "Agent 9": 9,
  "Agent 10": 10
};

// التحقق من أن الحساب Director
function isDirector(officer) {
  return Boolean(
    officer &&
    String(officer.role || "").toLowerCase() === "admin"
  );
}

// استخراج مستوى رتبة الضابط
function getRankLevel(officer) {
  if (!officer) return null;

  return Object.prototype.hasOwnProperty.call(
    RANKS,
    officer.rank
  )
    ? RANKS[officer.rank]
    : null;
}

// التحقق من الحد الأدنى للرتبة
function hasMinimumRank(officer, minimumRank) {
  if (isDirector(officer)) return true;

  const level = getRankLevel(officer);

  if (level === null) return false;

  return level <= RANKS[minimumRank];
}

// إنشاء Middleware للتحقق من الصلاحية
function authorize(minimumRank) {
  return function (req, res, next) {
    const officer = req.session?.officer;

    if (!officer) {
      return res.status(401).json({
        success: false,
        error: "يجب تسجيل الدخول أولاً."
      });
    }

    if (
      !Object.prototype.hasOwnProperty.call(
        RANKS,
        minimumRank
      )
    ) {
      return res.status(500).json({
        success: false,
        error: "إعداد الصلاحية غير صحيح."
      });
    }

    if (!hasMinimumRank(officer, minimumRank)) {
      return res.status(403).json({
        success: false,
        error: "ليست لديك الصلاحية لتنفيذ هذا الإجراء."
      });
    }

    next();
  };
}

module.exports = {
  RANKS,
  isDirector,
  getRankLevel,
  hasMinimumRank,
  authorize
};
