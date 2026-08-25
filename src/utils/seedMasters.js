const AllowanceDeductionMaster = require('../models/AllowanceDeductionMaster');
const logger = require('./logger');

/**
 * Default Overtime Allowance master record.
 * Uses SLAB calculation: hourly rate depends on total overtime hours worked in the cycle.
 *   0 – 10 hrs  →  ₹100/hr  (fixedAmount is per-slab total, but we store it as hourly in the slab)
 *   > 10 hrs    →  ₹150/hr
 *
 * NOTE: The payslipService will pick the correct slab based on total OT hours,
 * then multiply the corresponding hourly rate by the actual number of hours.
 */
const OVERTIME_MASTER = {
  name: 'Overtime Allowance',
  code: 'OVERTIME',
  type: 'ALLOWANCE',
  calculationType: 'SLAB',
  percentageOf: 'CTC',   // Not used for OT — payslipService handles calculation directly
  value: 0,              // Not used for OT slab-based
  slabs: [
    { minAmount: 0,  maxAmount: 10,   fixedAmount: 100 }, // 0–10 OT hrs → ₹100 per hour
    { minAmount: 10, maxAmount: null, fixedAmount: 150 }, // >10 OT hrs  → ₹150 per hour
  ],
  isBalancing: false,
  isTaxable: false,
  isActive: true,
  displayOrder: 90,
};

/**
 * Default Night Shift Allowance master record.
 * FIXED: each qualified night shift day earns a flat amount (₹200 default).
 * Admins can switch to SLAB to configure shift-count-based tiers.
 */
const NIGHT_SHIFT_MASTER = {
  name: 'Night Shift Allowance',
  code: 'NIGHT_SHIFT',
  type: 'ALLOWANCE',
  calculationType: 'FIXED',
  percentageOf: 'CTC',   // Not used for Night Shift — payslipService handles calculation directly
  value: 200,            // ₹200 per qualified night shift (default)
  slabs: [],
  isBalancing: false,
  isTaxable: false,
  isActive: true,
  displayOrder: 91,
};

/**
 * Seeds OVERTIME and NIGHT_SHIFT allowance master records if they do not exist.
 * Safe to call on every startup (idempotent).
 */
async function seedAllowanceMasters() {
  try {
    const defaults = [OVERTIME_MASTER, NIGHT_SHIFT_MASTER];

    for (const def of defaults) {
      const exists = await AllowanceDeductionMaster.findOne({ code: def.code });
      if (!exists) {
        await AllowanceDeductionMaster.create(def);
        logger.info(`✅ Seeded AllowanceDeductionMaster: ${def.name} (${def.code})`);
      }
    }
  } catch (err) {
    // Non-fatal: log warning but do not crash the server
    logger.warn(`⚠️  seedAllowanceMasters failed (non-fatal): ${err.message}`);
  }
}

module.exports = { seedAllowanceMasters };
