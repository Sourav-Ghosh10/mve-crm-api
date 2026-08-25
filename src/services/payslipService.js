const Payslip = require('../models/Payslip');
const SalaryConfig = require('../models/SalaryConfig');
const AllowanceDeductionMaster = require('../models/AllowanceDeductionMaster');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Schedule = require('../models/Schedule');
const Leave = require('../models/Leave');
const LeaveType = require('../models/LeaveType');
const Reimbursement = require('../models/Reimbursement');
const emailService = require('./emailService');
const { generatePayslipPDF } = require('../utils/pdfGenerator');
const { NotFoundError, ConflictError } = require('../utils/errors');
const logger = require('../utils/logger');
const { getPayrollCycleInterval } = require('../utils/payrollCycleHelper');
const moment = require('moment-timezone');

const toDateKey = (date) => moment(date).tz('Asia/Kolkata').format('YYYY-MM-DD');

const getCycleDayKeys = (startDate, endDate) => {
  const days = [];
  const current = moment(startDate).tz('Asia/Kolkata').startOf('day');
  const end = moment(endDate).tz('Asia/Kolkata').startOf('day');
  while (current.isSameOrBefore(end)) {
    days.push(current.format('YYYY-MM-DD'));
    current.add(1, 'day');
  }
  return days;
};

const getLeaveDaysInCycle = (leave, cycleDayKeys) => {
  const leaveDays = cycleDayKeys.filter(day => {
    const date = moment(day, 'YYYY-MM-DD');
    return date.isSameOrAfter(moment(leave.startDate).tz('Asia/Kolkata').startOf('day')) &&
      date.isSameOrBefore(moment(leave.endDate).tz('Asia/Kolkata').startOf('day'));
  });
  const totalCalendarDays = Math.max(1, moment(leave.endDate).tz('Asia/Kolkata').startOf('day')
    .diff(moment(leave.startDate).tz('Asia/Kolkata').startOf('day'), 'days') + 1);
  const dailyLeaveValue = Number(leave.numberOfDays || 0) / totalCalendarDays;

  return leaveDays.map(day => ({ day, value: dailyLeaveValue }));
};

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
    const { employeeId, month, year } = data;

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

    const [approvedLeaves, leaveTypes, approvedReimbursements] = await Promise.all([
      Leave.find({
        employeeId,
        status: 'approved',
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
      }),
      LeaveType.find({}).select('name code isPaid'),
      Reimbursement.find({
        employeeId,
        status: 'approved',
        expenseDate: { $gte: startDate, $lte: endDate },
        isActive: true,
      }).select('amount reimbursementType'),
    ]);

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

    // Derive payable days from attendance and approved unpaid leave. Paid leave
    // remains payable, while absent and unpaid-leave days are salary LOP days.
    const cycleDayKeys = getCycleDayKeys(startDate, endDate);
    const lossByDate = new Map();
    attendanceRecords.forEach(record => {
      const day = toDateKey(record.date);
      if (record.status === 'absent') lossByDate.set(day, 1);
      if (record.status === 'half-day') lossByDate.set(day, 0.5);
    });

    const leaveTypeIsPaid = new Map();
    leaveTypes.forEach(type => {
      leaveTypeIsPaid.set(type.name.toLowerCase(), type.isPaid !== false);
      leaveTypeIsPaid.set(type.code.toLowerCase(), type.isPaid !== false);
    });
    approvedLeaves.forEach(leave => {
      const leaveType = (leave.leaveType || '').toLowerCase();
      const isPaidLeave = leaveTypeIsPaid.get(leaveType) ?? !leaveType.includes('unpaid');
      if (isPaidLeave) return;

      getLeaveDaysInCycle(leave, cycleDayKeys).forEach(({ day, value }) => {
        lossByDate.set(day, Math.max(lossByDate.get(day) || 0, value));
      });
    });

    const calculatedTotalDays = cycleDayKeys.length;
    const calculatedLopDays = Number([...lossByDate.values()]
      .reduce((total, value) => total + value, 0).toFixed(2));
    const calculatedDaysWorked = Number(Math.max(0, calculatedTotalDays - calculatedLopDays).toFixed(2));
    const reimbursementTotal = Number(approvedReimbursements
      .reduce((total, reimbursement) => total + Number(reimbursement.amount || 0), 0).toFixed(2));

    // Check if payslip already exists
    const existing = await Payslip.findOne({ employeeId, month, year });
    if (existing) {
      throw new ConflictError('Payslip already exists for this month and year');
    }

    // Get active salary config
    const salaryConfig = await SalaryConfig.findOne({ 
      employeeId, 
      isActive: true,
      effectiveFrom: { $lte: endDate }
    })
      .sort({ effectiveFrom: -1 })
      .populate('items.masterId');

    if (!salaryConfig) {
      throw new NotFoundError('No active salary configuration found for this employee');
    }

    const items = [];
    let grossEarnings = 0;
    let totalDeductions = 0;
    let basicComponentValue = 0;

    // Fallback for monthlyCTC (handling legacy records)
    const baseAmount = Number(salaryConfig.monthlyCTC || salaryConfig.basicSalary || 0);
    const safeTotalDays = calculatedTotalDays || 30;
    const safeDaysWorked = calculatedDaysWorked;

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
        // Per-employee overrides are used for PF, tax, and every other
        // configured gross-based allowance/deduction as well.
        const percentage = item.overrideValue !== null
          ? Number(item.overrideValue)
          : Number(master.value || 0);
        const amount = (grossEarnings * percentage) / 100;
        
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

    // Approved reimbursements are paid with salary as a non-configured allowance.
    // They are added after salary deductions so PF/tax retain their configured bases.
    if (reimbursementTotal > 0) {
      items.push({
        name: 'Approved Reimbursements',
        code: 'REIMBURSEMENT',
        type: 'ALLOWANCE',
        amount: reimbursementTotal,
        isManualOverride: false,
      });
      grossEarnings += reimbursementTotal;
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
      totalDays: calculatedTotalDays,
      daysWorked: calculatedDaysWorked,
      lopDays: calculatedLopDays,
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
