const Payslip = require('../models/Payslip');
const SalaryConfig = require('../models/SalaryConfig');
const AllowanceDeductionMaster = require('../models/AllowanceDeductionMaster');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Schedule = require('../models/Schedule');
const emailService = require('./emailService');
const { generatePayslipPDF } = require('../utils/pdfGenerator');
const { NotFoundError, ConflictError } = require('../utils/errors');
const logger = require('../utils/logger');
const { getPayrollCycleInterval } = require('../utils/payrollCycleHelper');
const moment = require('moment-timezone');

const payslipService = {
  getPayslips: async ({ page, limit, filters }) => {
    const query = {};
    if (filters.employeeId) query.employeeId = filters.employeeId;
    if (filters.month) query.month = filters.month;
    if (filters.year) query.year = filters.year;
    if (filters.status) query.status = filters.status;

    const [payslips, total] = await Promise.all([
      Payslip.find(query)
        .populate('employeeId', 'employeeId personalInfo employment')
        .sort({ year: -1, month: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Payslip.countDocuments(query),
    ]);

    return { payslips, total };
  },

  getPayslipById: async (id) => {
    const payslip = await Payslip.findById(id)
      .populate('employeeId', 'employeeId personalInfo employment')
      .populate('salaryConfigId')
      .lean();
    if (!payslip) {
      throw new NotFoundError('Payslip not found');
    }
    return payslip;
  },

  generatePayslip: async (data) => {
    const { employeeId, month, year, daysWorked, totalDays, lopDays } = data;

    // Resolve the start and end dates of the target month/year's payroll cycle
    const { startDate, endDate } = await getPayrollCycleInterval(year, month);

    if (new Date() <= endDate) {
      throw new ConflictError(`Generation unlocks after ${moment(endDate).format('DD MMM YYYY')}`);
    }

    // Fetch attendance records and schedules in cycle
    const attendanceRecords = await Attendance.find({
      employeeId,
      date: { $gte: startDate, $lte: endDate },
    });

    const nightSchedules = await Schedule.find({
      employeeId,
      shiftType: 'night',
      date: { $gte: startDate, $lte: endDate },
    });

    // 1. Overtime: calculate total overtime hours from attendance records
    const totalOTHours = attendanceRecords.reduce((sum, rec) => sum + (rec.overtime || 0), 0);

    // 2. Night Shift: count active/qualified night shifts
    const activeAttendanceDates = new Set(
      attendanceRecords
        .filter(rec => ['present', 'half-day'].includes(rec.status))
        .map(rec => moment(rec.date).format('YYYY-MM-DD'))
    );

    let nightShiftsCount = 0;
    for (const sched of nightSchedules) {
      const schedDateStr = moment(sched.date).format('YYYY-MM-DD');
      if (activeAttendanceDates.has(schedDateStr)) {
        nightShiftsCount++;
      }
    }

    // Check if payslip already exists
    const existing = await Payslip.findOne({ employeeId, month, year });
    if (existing) {
      throw new ConflictError('Payslip already exists for this month and year');
    }

    // Get active salary config
    const salaryConfig = await SalaryConfig.findOne({ 
      employeeId, 
      isActive: true,
      effectiveFrom: { $lte: new Date(year, month - 1, totalDays) }
    }).populate('items.masterId');

    if (!salaryConfig) {
      throw new NotFoundError('No active salary configuration found for this employee');
    }

    const items = [];
    let grossEarnings = 0;
    let totalDeductions = 0;
    let basicComponentValue = 0;

    // Fallback for monthlyCTC (handling legacy records)
    const baseAmount = Number(salaryConfig.monthlyCTC || salaryConfig.basicSalary || 0);
    const safeTotalDays = Number(totalDays) || 30;
    const safeDaysWorked = Number(daysWorked) || 0;

    // Pro-rata Monthly CTC for reference
    const adjustedCTC = (baseAmount / safeTotalDays) * safeDaysWorked;
    
    // First Pass: Calculate all components based on CTC or FIXED
    const processedItems = [];
    for (const item of salaryConfig.items) {
      if (!item.isActive) continue;
      const master = item.masterId;
      if (!master || master.isBalancing || master.code === 'OVERTIME' || master.code === 'NIGHT_SHIFT') continue;

      let amount = item.overrideValue !== null ? Number(item.overrideValue) : Number(master.value || 0);

      // We only handle CTC based or fixed in first pass
      if (
        master.calculationType === 'SLAB' || 
        (master.calculationType === 'PERCENTAGE' && (master.percentageOf === 'BASIC' || master.percentageOf === 'GROSS'))
      ) {
        processedItems.push(item); // Save for later passes
        continue;
      }

      if (master.calculationType === 'PERCENTAGE') {
        amount = (baseAmount * amount) / 100;
      }

      // Pro-rata adjustment
      const finalAmount = (amount / safeTotalDays) * safeDaysWorked;

      if (master.code === 'BASIC') {
        basicComponentValue = amount; // Use raw monthly basic for other dependencies
      }

      items.push({
        masterId: master._id,
        name: master.name,
        code: master.code,
        type: master.type,
        amount: Math.round(finalAmount * 100) / 100,
        isManualOverride: false
      });

      if (master.type === 'ALLOWANCE') grossEarnings += finalAmount;
      else totalDeductions += finalAmount;
    }

    // Second Pass: Calculate components based on BASIC
    for (const item of processedItems) {
      const master = item.masterId;
      if (!(master.calculationType === 'PERCENTAGE' && master.percentageOf === 'BASIC')) continue;

      let amount = item.overrideValue !== null ? Number(item.overrideValue) : Number(master.value || 0);
      amount = (basicComponentValue * amount) / 100;

      const finalAmount = (amount / safeTotalDays) * safeDaysWorked;

      items.push({
        masterId: master._id,
        name: master.name,
        code: master.code,
        type: master.type,
        amount: Math.round(finalAmount * 100) / 100,
        isManualOverride: false
      });

      if (master.type === 'ALLOWANCE') grossEarnings += finalAmount;
      else totalDeductions += finalAmount;
    }

    // Third Pass: Balancing Components (CTC Remainder)
    for (const item of salaryConfig.items) {
      if (!item.isActive) continue;
      const master = item.masterId;
      if (!master || !master.isBalancing) continue;

      // Balancing allowance = Adjusted CTC - Current Gross Earnings
      const balancingAmount = Math.max(0, adjustedCTC - grossEarnings);

      items.push({
        masterId: master._id,
        name: master.name,
        code: master.code,
        type: master.type,
        amount: Math.round(balancingAmount * 100) / 100,
        isManualOverride: false
      });

      if (master.type === 'ALLOWANCE') grossEarnings += balancingAmount;
      else totalDeductions += balancingAmount;
    }

    // Pass 3.5: Overtime & Night Shift Allowances (computed post-balancing but pre-gross-based-deductions)
    for (const item of salaryConfig.items) {
      if (!item.isActive) continue;
      const master = item.masterId;
      if (!master || (master.code !== 'OVERTIME' && master.code !== 'NIGHT_SHIFT')) continue;

      let computedAmount = 0;

      if (master.code === 'OVERTIME') {
        if (master.calculationType === 'SLAB') {
          const slab = (master.slabs || []).find(s => 
            totalOTHours >= s.minAmount && (!s.maxAmount || totalOTHours <= s.maxAmount)
          );
          const hourlyRate = slab ? Number(slab.fixedAmount) : 0;
          computedAmount = totalOTHours * hourlyRate;
        } else if (master.calculationType === 'PERCENTAGE') {
          const percentage = item.overrideValue !== null ? Number(item.overrideValue) : Number(master.value || 0);
          const hourlyRate = (basicComponentValue / safeTotalDays / 8) * (percentage / 100);
          computedAmount = totalOTHours * hourlyRate;
        } else {
          const hourlyRate = item.overrideValue !== null ? Number(item.overrideValue) : Number(master.value || 0);
          computedAmount = totalOTHours * hourlyRate;
        }
      } else if (master.code === 'NIGHT_SHIFT') {
        if (master.calculationType === 'SLAB') {
          const slab = (master.slabs || []).find(s => 
            nightShiftsCount >= s.minAmount && (!s.maxAmount || nightShiftsCount <= s.maxAmount)
          );
          const shiftRate = slab ? Number(slab.fixedAmount) : 0;
          computedAmount = nightShiftsCount * shiftRate;
        } else {
          const shiftRate = item.overrideValue !== null ? Number(item.overrideValue) : Number(master.value || 0);
          computedAmount = nightShiftsCount * shiftRate;
        }
      }

      const finalAmount = Math.round(computedAmount * 100) / 100;

      items.push({
        masterId: master._id,
        name: master.name,
        code: master.code,
        type: master.type,
        amount: finalAmount,
        isManualOverride: false
      });

      if (master.type === 'ALLOWANCE') grossEarnings += finalAmount;
      else totalDeductions += finalAmount;
    }

    // Fourth Pass: Calculate components based on GROSS (finalized earnings)
    for (const item of salaryConfig.items) {
      if (!item.isActive) continue;
      const master = item.masterId;
      if (!master || master.isBalancing || master.code === 'OVERTIME' || master.code === 'NIGHT_SHIFT') continue; // Balancing handled in Pass 3, OT/Night shift in Pass 3.5

      if (master.calculationType === 'PERCENTAGE' && master.percentageOf === 'GROSS') {
        const amount = (grossEarnings * master.value) / 100;
        
        items.push({
          masterId: master._id,
          name: master.name,
          code: master.code,
          type: master.type,
          amount: Math.round(amount * 100) / 100,
          isManualOverride: false
        });

        if (master.type === 'ALLOWANCE') grossEarnings += amount;
        else totalDeductions += amount;
      } 
      else if (master.calculationType === 'SLAB') {
        // Slab calculations are typically based on GROSS for things like PTax
        const baseForSlab = master.percentageOf === 'BASIC' ? basicComponentValue : 
                           master.percentageOf === 'GROSS' ? grossEarnings : baseAmount;
        
        const slab = (master.slabs || []).find(s => 
          baseForSlab >= s.minAmount && (!s.maxAmount || baseForSlab <= s.maxAmount)
        );
        
        const amount = slab ? slab.fixedAmount : 0;

        items.push({
          masterId: master._id,
          name: master.name,
          code: master.code,
          type: master.type,
          amount: Math.round(amount * 100) / 100,
          isManualOverride: false
        });

        if (master.type === 'ALLOWANCE') grossEarnings += amount;
        else totalDeductions += amount;
      }
    }

    const netPay = grossEarnings - totalDeductions;

    const payslip = await Payslip.create({
      employeeId,
      salaryConfigId: salaryConfig._id,
      month,
      year,
      monthlyCTC: Math.round(adjustedCTC * 100) / 100,
      items,
      grossEarnings: Math.round(grossEarnings * 100) / 100,
      totalDeductions: Math.round(totalDeductions * 100) / 100,
      netPay: Math.round(netPay * 100) / 100,
      totalDays,
      daysWorked,
      lopDays,
      status: 'DRAFT',
      generatedBy: data.requestedBy
    });

    logger.info(`Payslip generated for employee: ${employeeId}, Month: ${month}, Year: ${year}`);
    return payslip;
  },

  updatePayslipStatus: async (id, status, finalizedBy) => {
    const updateData = { status, updatedAt: new Date() };
    if (status === 'FINALIZED') {
      updateData.finalizedBy = finalizedBy;
      updateData.finalizedAt = new Date();
    }

    const payslip = await Payslip.findByIdAndUpdate(id, updateData, { new: true });
    if (!payslip) {
      throw new NotFoundError('Payslip not found');
    }

    logger.info(`Payslip status updated: ${id} to ${status}`);
    return payslip;
  },

  deletePayslip: async (id) => {
    const payslip = await Payslip.findByIdAndDelete(id);
    if (!payslip) {
      throw new NotFoundError('Payslip not found');
    }
    logger.info(`Payslip deleted: ${id}`);
    return payslip;
  },

  sendPayslipEmail: async (id) => {
    const payslip = await Payslip.findById(id).populate('employeeId');
    if (!payslip) {
      throw new NotFoundError('Payslip not found');
    }

    const user = payslip.employeeId;
    if (!user || !user.personalInfo?.email) {
      throw new ConflictError('Employee email not found');
    }

    let pdfBuffer = null;
    try {
      pdfBuffer = await generatePayslipPDF(payslip, user);
    } catch (pdfError) {
      logger.error('PDF generation failed:', pdfError);
      // We continue without PDF if generation fails, or we could throw error
    }

    const success = await emailService.sendPayslipEmail(user, payslip, pdfBuffer);
    if (!success) {
      throw new Error('Failed to send payslip email');
    }

    return true;
  }
};

module.exports = payslipService;
