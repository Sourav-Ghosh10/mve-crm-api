const Leave = require('../models/Leave');
const User = require('../models/User');
const LeaveType = require('../models/LeaveType');
const LeaveLedger = require('../models/LeaveLedger');
const Holiday = require('../models/Holiday');
const Schedule = require('../models/Schedule');
const SystemSettings = require('../models/SystemSettings');
const emailService = require('../services/emailService');
const { AppError, BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const catchAsync = require('../utils/catchAsync');
const { calculateDaysBetween } = require('../utils/dateUtils');
const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const moment = require('moment-timezone');
const WORKING_HOURS_PER_DAY = 8;

// Calculate an early leave's duration from its selected departure time through
// the employee's scheduled roster end time.
const calculateEarlyLeaveHours = (leave, schedule, fallbackEndTime) => {
    const departureTime = new Date(leave.startDate);
    if (Number.isNaN(departureTime.getTime())) return 0;

    const rosterEnd = schedule?.endTime?.[schedule.endTime.length - 1] || fallbackEndTime || '18:00';
    const [hours, minutes] = rosterEnd.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;

    const rosterEndTime = new Date(departureTime);
    rosterEndTime.setHours(hours, minutes, 0, 0);
    return Math.max(0, (rosterEndTime.getTime() - departureTime.getTime()) / (1000 * 60 * 60));
};

// Helper to calculate days (excluding weekly offs and holidays)
const calculateLeaveDays = (start, end, halfDay, userSettings = {}) => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const { weeklyOff = [], holidays = [], isHolidayApplicable = true, schedules = [] } = userSettings;

    // Create a map for quick schedule lookup: "YYYY-MM-DD" -> scheduleDoc
    const scheduleMap = new Map();
    schedules.forEach(s => {
        const dateKey = new Date(s.date).toISOString().split('T')[0];
        scheduleMap.set(dateKey, s);
    });

    let days = 0;
    let current = new Date(startDate);

    while (current <= endDate) {
        const dateKey = current.toISOString().split('T')[0];
        const dayOfWeek = current.toLocaleDateString('en-US', { weekday: 'long' });

        // Check if it's a holiday
        // If user is NOT applicable for holidays, then a holiday counts as a working day (unless it's a week off)
        // Wait, requirement: "holiday is not count in a leave if user applicable for leave"
        // So ONLY if isHolidayApplicable AND it is a holiday, we skip counting.
        const isHoliday = isHolidayApplicable && holidays.some(h => {
            const hDate = new Date(h.date);
            return hDate.toISOString().split('T')[0] === dateKey;
        });

        // Check if it's a weekly off
        // Priority: Schedule > Default Weekly Off
        let isWeeklyOff = false;

        if (scheduleMap.has(dateKey)) {
            const schedule = scheduleMap.get(dateKey);
            isWeeklyOff = schedule.shiftType === 'off';
        } else {
            // Fallback to default weekly off if no schedule generated yet
            isWeeklyOff = weeklyOff.includes(dayOfWeek);
        }

        
        // If it's Saturday and Saturday half day is enabled, it's NOT a weekly off
        if (dayOfWeek === 'Saturday' && userSettings.isSaturdayHalfDay) {
            isWeeklyOff = false;
        }

        if (!isWeeklyOff && !isHoliday) {
            if (dayOfWeek === 'Saturday' && userSettings.isSaturdayHalfDay) {
                days += 0.5;
            } else {
                days++;
            }
        }

        current.setDate(current.getDate() + 1);
    }

    if (halfDay) {
        // If the single day selected is a holiday or weekly off, days will be 0
        if (days === 0) {
            throw new BadRequestError('Cannot apply for half-day leave on a holiday or weekly off.');
        }
        return days / 2;
    }
    return days;
};

const leaveController = {
    // Calculate leave duration (days)
    calculateLeaveDuration: catchAsync(async (req, res) => {
        const { startDate, endDate } = req.query;
        const halfDay = req.query.halfDay === 'true'; // Parse string "true" to boolean true
        const userId = req.user._id;

        const user = await User.findById(userId);
        if (!user) throw new NotFoundError('User not found');

        // Fetch holidays for the period
        const holidays = await Holiday.find({
            isActive: true,
            date: { $gte: new Date(startDate), $lte: new Date(endDate) }
        });

        // Fetch schedules for the period
        const schedules = await Schedule.find({
            employeeId: userId,
            date: { $gte: new Date(startDate), $lte: new Date(endDate) }
        });

        const satSetting = await SystemSettings.findOne({ key: 'saturday_half_day' });
        const isSaturdayHalfDay = satSetting?.value?.enabled || false;

        const userSettings = {
            isSaturdayHalfDay,
            weeklyOff: user.employment?.workingHours?.weeklyOff || [],
            holidays,
            isHolidayApplicable: user.isHolidayApplicable !== false,
            schedules
        };

        const numberOfDays = calculateLeaveDays(startDate, endDate, halfDay, userSettings);

        res.json({
            status: 'success',
            data: {
                numberOfDays
            }
        });
    }),

    // Create a new leave request
    createLeaveRequest: catchAsync(async (req, res) => {
        const { leaveType, startDate, endDate, halfDay, halfDayType, reason, attachments, isEarlyLeave, requestedHours } = req.body;
        const userId = req.user._id;

        // Check for overlapping leaves
        const overlapping = await Leave.findOverlapping(userId, startDate, endDate);
        if (overlapping.length > 0) {
            throw new BadRequestError('You already have a leave request for this period.');
        }

        // Initial check for leave balance
        const user = await User.findById(userId);
        if (!user) throw new NotFoundError('User not found');

        // Fetch holidays for the period
        const holidays = await Holiday.find({
            isActive: true,
            date: { $gte: new Date(startDate), $lte: new Date(endDate) }
        });

        // Fetch schedules for the period to check for roster-based offs
        const schedules = await Schedule.find({
            employeeId: userId,
            date: { $gte: new Date(startDate), $lte: new Date(endDate) }
        });

        const satSetting = await SystemSettings.findOne({ key: 'saturday_half_day' });
        const isSaturdayHalfDay = satSetting?.value?.enabled || false;

        const userSettings = {
            isSaturdayHalfDay,
            weeklyOff: user.employment?.workingHours?.weeklyOff || [],
            holidays,
            isHolidayApplicable: user.isHolidayApplicable !== false,
            schedules
        };

        const numberOfDays = calculateLeaveDays(startDate, endDate, halfDay, userSettings);

        if (numberOfDays <= 0) {
            throw new BadRequestError('The selected date range only contains holidays or weekly offs.');
        }

        const userDept = user.employment?.department;

        // Fetch leave type configuration - search by code or name, and check department
        const leaveTypeInfo = await LeaveType.findOne({
            $or: [
                { code: leaveType.toUpperCase() },
                { name: new RegExp(`^${leaveType}$`, 'i') }
            ],
            isActive: true,
            applicableDepartments: { $in: ['all', userDept] }
        });

        // Check applicability
        if (leaveType.toLowerCase() !== 'unpaid' && !leaveTypeInfo) {
            throw new ForbiddenError(`This leave type is either invalid or not applicable to your department (${userDept}).`);
        }

        const canonicalName = leaveTypeInfo ? leaveTypeInfo.name : leaveType;
        const isUnpaid = leaveType.toLowerCase() === 'unpaid' ||
            (leaveTypeInfo && leaveTypeInfo.isPaid === false) ||
            (leaveTypeInfo && leaveTypeInfo.code === 'LWP');

        // Dynamic Balance Calculation (Allocated - Taken/Pending)
        let currentBalance = 0;
        if (isUnpaid) {
            currentBalance = Infinity;
        } else if (leaveTypeInfo) {
            if (user.leaveBalance && user.leaveBalance.has(canonicalName)) {
                const pendingLeaves = await Leave.find({
                    employeeId: userId,
                    leaveType: { $in: [leaveTypeInfo.name, leaveTypeInfo.code] },
                    status: 'pending'
                });
                const totalPending = pendingLeaves.reduce((sum, l) => sum + l.numberOfDays, 0);
                currentBalance = user.leaveBalance.get(canonicalName) - totalPending;
            } else {
                const startOfYear = new Date(new Date().getFullYear(), 0, 1);
                const endOfYear = new Date(new Date().getFullYear(), 11, 31, 23, 59, 59, 999);
                const leavesTaken = await Leave.find({
                    employeeId: userId,
                    leaveType: { $in: [leaveTypeInfo.name, leaveTypeInfo.code] },
                    status: { $in: ['approved', 'pending'] },
                    startDate: { $gte: startOfYear, $lte: endOfYear }
                });
                const totalTaken = leavesTaken.reduce((sum, l) => sum + l.numberOfDays, 0);
                currentBalance = Math.max(0, (leaveTypeInfo.defaultAmount || 0) - totalTaken);
            }
        }

        // console.log(`Dynamic Balance for ${canonicalName}: ${currentBalance}`);

        // Policy logic
        if (!isUnpaid && currentBalance < numberOfDays) {
            throw new BadRequestError(`Insufficient ${leaveType} leave balance. Available: ${currentBalance}, Requested: ${numberOfDays}`);
        }

        const leave = await Leave.create({
            employeeId: userId,
            leaveType: leaveTypeInfo ? leaveTypeInfo.name : leaveType,
            startDate,
            endDate,
            numberOfDays,
            halfDay,
            halfDayType,
            reason,
            attachments,
            status: 'pending',
        });

        // --- Send Notifications ---
        try {
            // 1. Get Recipients (Reporting Manager + Higher Management)
            const reportingChain = await user.getReportingChain();
            // reportingChain[0] is current user, so we take the rest
            const managers = reportingChain.slice(1);
            const managerEmails = managers
                .map(m => m.personalInfo?.email)
                .filter(email => !!email);

            // 2. Get Additional Configured Emails
            const adminSetting = await SystemSettings.findOne({ key: 'leave_notification_emails' });
            const additionalEmails = adminSetting?.value || [];
            
            const allRecipients = Array.from(new Set([...managerEmails, ...additionalEmails]));

            if (allRecipients.length > 0) {
                await emailService.sendLeaveApplicationEmail(user, leave, allRecipients);
            }
        } catch (emailError) {
            console.error('Failed to send leave application emails:', emailError);
            // Don't fail the request if email fails
        }

        res.status(201).json({
            status: 'success',
            data: leave,
        });
    }),

    // Get all leave requests (Admin/Manager)
    getLeaveRequests: catchAsync(async (req, res) => {
        const { page = 1, limit = 20, status, userId, leaveType, search } = req.query;
        const query = {};

        if (status) query.status = status;
        if (userId) query.employeeId = userId;
        if (leaveType) query.leaveType = leaveType;

        if (search) {
            const users = await User.find({
                $or: [
                    { 'personalInfo.firstName': { $regex: search, $options: 'i' } },
                    { 'personalInfo.lastName': { $regex: search, $options: 'i' } },
                    { 'personalInfo.email': { $regex: search, $options: 'i' } },
                    {
                        $expr: {
                            $regexMatch: {
                                input: { $concat: ['$personalInfo.firstName', ' ', '$personalInfo.lastName'] },
                                regex: search,
                                options: 'i',
                            },
                        },
                    },
                ],
            }).select('_id');

            const userIds = users.map((user) => user._id);
            if (query.employeeId) {
                if (!userIds.some(id => id.equals(query.employeeId))) {
                    return res.json({
                        status: 'success',
                        data: [],
                        pagination: { page: parseInt(page), limit: parseInt(limit), total: 0, pages: 0 }
                    });
                }
            } else {
                query.employeeId = { $in: userIds };
            }
        }

        // RBAC & Hierarchy Filtering
        const userRole = (req.user.employment?.role || '').toLowerCase();
        const canApprove = req.user.permissions?.canApproveLeave || false;
        const isAdminOrHR = userRole === 'admin' || userRole === 'hr' || userRole === 'super admin' || req.user.isAdmin;

        // If user is Admin/HR or has explicit approve permission, they can see everything (filters apply normally)
        if (!isAdminOrHR && !canApprove) {
            if (userRole === 'manager') {
                // Find all subordinates (direct and indirect) using recursive search
                const hierarchyData = await User.aggregate([
                    { $match: { _id: req.user._id } },
                    {
                        $graphLookup: {
                            from: 'users',
                            startWith: '$_id',
                            connectFromField: '_id',
                            connectToField: 'employment.reportingManager',
                            as: 'allSubordinates'
                        }
                    },
                    {
                        $project: {
                            allSubordinateIds: '$allSubordinates._id'
                        }
                    }
                ]);

                const subordinateIds = hierarchyData[0]?.allSubordinateIds || [];
                // Managers can see their own + subordinates
                const allowedIds = [...subordinateIds, req.user._id];

                if (query.employeeId) {
                    const targetId = mongoose.Types.ObjectId.isValid(query.employeeId)
                        ? new mongoose.Types.ObjectId(query.employeeId)
                        : query.employeeId;

                    if (!allowedIds.some(sid => sid.equals(targetId))) {
                        return res.json({
                            status: 'success',
                            data: [],
                            pagination: { page: parseInt(page), limit: parseInt(limit), total: 0, totalPages: 0 }
                        });
                    }
                } else {
                    query.employeeId = { $in: allowedIds };
                }
            } else {
                // Regular employees: If they hit this route, restrict to their OWN requests
                if (query.employeeId && query.employeeId.toString() !== req.user._id.toString()) {
                    return res.json({
                        status: 'success',
                        data: [],
                        pagination: { page: parseInt(page), limit: parseInt(limit), total: 0, totalPages: 0 }
                    });
                }
                query.employeeId = req.user._id;
            }
        }

        const leaves = await Leave.find(query)
            .populate('employeeId', 'personalInfo.firstName personalInfo.lastName employment.designation employment.reportingManager')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        const total = await Leave.countDocuments(query);

        res.json({
            status: 'success',
            data: leaves,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    }),

    // Get current user's leave requests
    getMyLeaveRequests: catchAsync(async (req, res) => {
        const { page = 1, limit = 20, status, leaveType, search } = req.query;
        const userId = req.user._id;
        const query = { employeeId: userId };

        if (status) query.status = status;
        if (leaveType) query.leaveType = leaveType;

        if (search) {
            query.reason = { $regex: search, $options: 'i' };
        }

        const leaves = await Leave.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        const total = await Leave.countDocuments(query);

        res.json({
            status: 'success',
            data: leaves,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    }),

    // Get Leave Balance
    getLeaveBalance: catchAsync(async (req, res) => {
        // If Admin/Manager requests for another user, use params.userId
        // Else use req.user._id
        let targetUserId = req.user._id;

        if (req.params.userId) {
            const userRole = (req.user.employment?.role || '').toLowerCase();
            const isAdminOrHR = userRole === 'admin' || userRole === 'super admin' || userRole === 'hr' || userRole === 'manager' || req.user.isAdmin;
            
            if (isAdminOrHR) {
                targetUserId = req.params.userId;
            } else if (req.params.userId !== req.user._id.toString()) {
                throw new ForbiddenError('You can only view your own leave balance.');
            }
        }

        const user = await User.findById(targetUserId).select('leaveBalance personalInfo employment.department');
        if (!user) throw new NotFoundError('User not found');

        // Fetch all active leave types applicable to this user's department
        const activeLeaveTypes = await LeaveType.find({
            isActive: true,
            $or: [
                { applicableDepartments: 'all' },
                { applicableDepartments: user.employment?.department }
            ]
        });

        // Filter for Current Year Only
        const startOfYear = new Date(new Date().getFullYear(), 0, 1);
        const endOfYear = new Date(new Date().getFullYear(), 11, 31, 23, 59, 59, 999);

        // Fetch approved leaves for this user to calculate used days per type
        const approvedLeaves = await Leave.find({
            employeeId: targetUserId,
            status: 'approved',
            startDate: { $gte: startOfYear, $lte: endOfYear }
        });

        // Build a mapping from name and code to canonical identifier (Raw Name)
        const typeResolutionMap = {};
        activeLeaveTypes.forEach(lt => {
            const canonicalName = lt.name;
            typeResolutionMap[lt.name.toLowerCase()] = canonicalName;
            typeResolutionMap[lt.code.toLowerCase()] = canonicalName;
        });

        const usedMap = {};
        approvedLeaves.forEach(l => {
            const rawType = (l.leaveType || '').toLowerCase();
            const canonicalCode = typeResolutionMap[rawType] || rawType;
            usedMap[canonicalCode] = (usedMap[canonicalCode] || 0) + l.numberOfDays;
        });

        // Calculate detailed balances for each applicable type
        const balances = activeLeaveTypes.map(lt => {
            const canonicalName = lt.name;
            const used = usedMap[canonicalName] || 0;
            let totalAllocated = typeof lt.defaultAmount === 'number' ? lt.defaultAmount : "";

            let currentBalance = 0;
            if (user.leaveBalance && user.leaveBalance.has(canonicalName)) {
                currentBalance = user.leaveBalance.get(canonicalName);
                if (typeof totalAllocated !== 'number') {
                    totalAllocated = currentBalance + used;
                }
            } else if (lt.isPaid && typeof totalAllocated === 'number') {
                currentBalance = Math.max(0, totalAllocated - used);
            } else {
                currentBalance = lt.isPaid ? 0 : ""; 
                if (!lt.isPaid) {
                    totalAllocated = "";
                }
            }

            return {
                leaveTypeId: lt._id,
                name: lt.name,
                code: lt.code,
                currentBalance: currentBalance,
                used: used,
                totalAllocated: totalAllocated,
                isPaid: lt.isPaid,
                accrualType: lt.accrualType,
                workingHoursPerDay: lt.workingHoursPerDay || 8
            };
        });

        // Ensure 'unpaid' is handled if not explicitly in LeaveTypes
        if (!balances.find(b => !b.isPaid || (b.code && ['UNPAID', 'LWP'].includes(b.code.toUpperCase())) || (b.name && b.name.toLowerCase().includes('unpaid')))) {
            const usedUnpaid = usedMap['unpaid'] || usedMap['Unpaid Leave'] || 0;
            balances.push({
                name: 'Unpaid Leave',
                code: 'UNPAID',
                currentBalance: "",
                used: usedUnpaid,
                totalAllocated: "",
                isPaid: false,
                workingHoursPerDay: 8
            });
        }

        // Ensure 'unpaid' is handled if not explicitly in LeaveTypes
        // if (!balances.find(b => b.code.toUpperCase() === 'UNPAID')) {
        //     const usedUnpaid = usedMap['unpaid'] || 0;
        //     balances.push({
        //         name: 'Unpaid Leave',
        //         code: 'UNPAID',
        //         currentBalance: Infinity,
        //         used: usedUnpaid,
        //         totalAllocated: Infinity,
        //         isPaid: false
        //     });
        // }

        res.json({
            status: 'success',
            data: {
                userId: user._id,
                name: user.fullName,
                department: user.employment?.department,
                balances,
            },
        });
    }),

    // Update Leave Status (Approve/Reject)
    updateLeaveStatus: catchAsync(async (req, res) => {
        const { id } = req.params;
        const { status, rejectionReason, approvalComment, isDeductFromBalance } = req.body;
        const approverId = req.user._id;

        const leave = await Leave.findById(id).populate('employeeId');
        if (!leave) throw new NotFoundError('Leave request not found');

        if (leave.status !== 'pending') {
            throw new BadRequestError(`Leave request is already ${leave.status}`);
        }

        // Permission Check: Reporting manager, Higher management, Admin/HR
        const requester = leave.employeeId;
        const reportingChain = await requester.getReportingChain(); // [user, manager, higher_manager...]
        const managerIds = reportingChain.slice(1).map(m => m._id.toString());
        
        const isManagerInChain = managerIds.includes(approverId.toString());
        const currentApproverRole = (req.user.employment?.role || '').toLowerCase();
        const isAdmin = currentApproverRole === 'admin' || currentApproverRole === 'hr' || currentApproverRole === 'super admin' || req.user.isAdmin;
        const hasApprovePermission = req.user.permissions?.canApproveLeave === true;

        if (!isManagerInChain && !isAdmin && !hasApprovePermission) {
            throw new ForbiddenError('You do not have permission to approve/reject this leave request. Only the reporting manager, higher management, or an administrator can perform this action.');
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            leave.status = status;

            // Update approval flow
            leave.approvalFlow.push({
                approverId: approverId,
                approverRole: req.user.employment.role,
                action: status,
                actionDate: new Date(),
                comments: rejectionReason || `${status === 'approved' ? 'Approved' : 'Rejected'} by manager`,
            });

            if (status === 'approved') {
                  // Dynamic balance logic: approving a leave record 
                  // automatically makes it "used" in the next calculation.
                  const isEarlyLeave = leave.leaveType && leave.leaveType.toLowerCase().includes('hourly');
                  
                  if (isEarlyLeave) {
                      if (isDeductFromBalance) {
                          const Schedule = require('../models/Schedule');
                          
                          const startOfDay = new Date(leave.startDate);
                          startOfDay.setHours(0, 0, 0, 0);
                          
                          const schedule = await Schedule.findOne({
                              employeeId: leave.employeeId,
                              date: { $gte: startOfDay, $lt: new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000) }
                          });
                          
                          let rosterEndHour = 18; // Default 6 PM
                          let rosterEndMinute = 0;
                          
                          if (schedule && schedule.endTime && schedule.endTime.length > 0) {
                              const timeStr = schedule.endTime[schedule.endTime.length - 1]; // e.g. "18:00"
                              const [hours, minutes] = timeStr.split(':');
                              if (!isNaN(parseInt(hours, 10))) rosterEndHour = parseInt(hours, 10);
                              if (!isNaN(parseInt(minutes, 10))) rosterEndMinute = parseInt(minutes, 10);
                          } else if (requester.employment?.workingHours?.endTime) {
                              const timeStr = requester.employment.workingHours.endTime;
                              const [hours, minutes] = timeStr.split(':');
                              if (!isNaN(parseInt(hours, 10))) rosterEndHour = parseInt(hours, 10);
                              if (!isNaN(parseInt(minutes, 10))) rosterEndMinute = parseInt(minutes, 10);
                          }
                          
                          const departureTime = new Date(leave.startDate);
                          const rosterEndTime = new Date(leave.startDate);
                          rosterEndTime.setHours(rosterEndHour, rosterEndMinute, 0, 0);
                          
                          const diffMs = rosterEndTime.getTime() - departureTime.getTime();
                          let diffHours = diffMs / (1000 * 60 * 60);
                          if (diffHours < 0) diffHours = 0;
                          
                          const calculatedDays = diffHours / 8; // 8-hour workday
                          
                          leave.numberOfDays = calculatedDays;
                      } else {
                          // Not deducting from balance
                          leave.numberOfDays = 0;
                      }
                  }
              } else if (status === 'rejected') {
                leave.rejectionReason = rejectionReason;
            }

            // Save with session only if session is provided and valid
            if (session && session.id) {
                await leave.save({ session });
                await session.commitTransaction();
            } else {
                await leave.save();
                if (session && typeof session.commitTransaction === 'function') {
                    await session.commitTransaction();
                }
            }

            res.json({
                status: 'success',
                data: leave,
            });

            // --- Send Notification to Employee ---
            try {
                await emailService.sendLeaveStatusUpdateEmail(requester, leave, status, rejectionReason);
            } catch (emailError) {
                console.error('Failed to send leave status update email:', emailError);
            }

        } catch (error) {
            if (session && typeof session.abortTransaction === 'function') {
                await session.abortTransaction();
            }
            throw error;
        } finally {
            if (session && typeof session.endSession === 'function') {
                session.endSession();
            }
        }
    }),

    // Cancel own leave request
    cancelMyLeave: catchAsync(async (req, res) => {
        const { id } = req.params;
        const { cancelReason } = req.body || {};
        const userId = req.user._id;

        const leave = await Leave.findById(id);

        if (!leave) {
            throw new NotFoundError('Leave request not found');
        }

        // Check ownership
        if (leave.employeeId.toString() !== userId.toString()) {
            throw new ForbiddenError('You can only cancel your own leave requests');
        }

        // Check status - only pending requests can be cancelled
        if (leave.status !== 'pending') {
            throw new BadRequestError(`Cannot cancel a leave request that is already ${leave.status}. Please refresh your page to see the latest status.`);
        }

        leave.status = 'cancelled';
        leave.cancelledAt = new Date();
        leave.cancelReason = cancelReason || 'Cancelled by employee';

        await leave.save();

        res.json({
            status: 'success',
            message: 'Leave request cancelled successfully',
            data: leave,
        });
    }),

    // Get Leave Stats for Dashboard
    getLeaveStats: catchAsync(async (req, res) => {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const [pendingApprovals, approvedToday, rejectedTotal, totalRequests] = await Promise.all([
            Leave.countDocuments({ status: 'pending' }),
            Leave.countDocuments({ status: 'approved', updatedAt: { $gte: startOfToday } }),
            Leave.countDocuments({ status: 'rejected' }),
            Leave.countDocuments({}),
        ]);

        res.json({
            status: 'success',
            data: {
                pendingApprovals,
                approvedToday,
                rejectedTotal,
                totalRequests,
            },
        });
    }),

    // Get my personal leave dashboard stats (for cards)
    getMyLeaveDashboardStats: catchAsync(async (req, res) => {
        const userId = req.user._id;

        const user = await User.findById(userId).select('leaveBalance employment.department employment.workingHours');
        if (!user) throw new NotFoundError('User not found');

        // Fetch all active leave types applicable to this user's department
        const activeLeaveTypes = await LeaveType.find({
            isActive: true,
            $or: [
                { applicableDepartments: 'all' },
                { applicableDepartments: user.employment?.department }
            ]
        });

        // Filter for Current Year Only
        const startOfYear = new Date(new Date().getFullYear(), 0, 1);
        const endOfYear = new Date(new Date().getFullYear(), 11, 31, 23, 59, 59, 999);

        // Fetch all approved leaves for this user to calculate accurate 'used' counts
        const approvedLeaves = await Leave.find({
            employeeId: userId,
            status: 'approved',
            startDate: { $gte: startOfYear, $lte: endOfYear }
        });

        const approvedEarlyLeaves = approvedLeaves.filter(leave => {
            const type = leave.leaveType?.toLowerCase() || '';
            return type.includes('hourly') || type.includes('early');
        });
        const earlyLeaveHours = await Promise.all(approvedEarlyLeaves.map(async leave => {
            const dayStart = new Date(leave.startDate);
            dayStart.setHours(0, 0, 0, 0);
            const nextDay = new Date(dayStart);
            nextDay.setDate(nextDay.getDate() + 1);
            const schedule = await Schedule.findOne({
                employeeId: userId,
                date: { $gte: dayStart, $lt: nextDay }
            }).select('endTime');

            return [leave._id.toString(), calculateEarlyLeaveHours(leave, schedule, user.employment?.workingHours?.endTime)];
        }));
        const earlyLeaveHoursById = new Map(earlyLeaveHours);

        // Build a mapping from name and code to canonical name (Raw)
        const typeResolutionMap = {};
        activeLeaveTypes.forEach(lt => {
            const canonicalName = lt.name;
            typeResolutionMap[lt.name.toLowerCase()] = canonicalName;
            typeResolutionMap[lt.code.toLowerCase()] = canonicalName;
        });

        const usedMap = {};
        approvedLeaves.forEach(l => {
            const rawType = (l.leaveType || '').toLowerCase();
            const canonicalName = typeResolutionMap[rawType] || rawType;
            usedMap[canonicalName] = (usedMap[canonicalName] || 0) + l.numberOfDays;
        });

        const approvedLeaveHours = approvedLeaves.reduce((total, leave) => {
            const type = leave.leaveType?.toLowerCase() || '';
            const isEarlyLeave = type.includes('hourly') || type.includes('early');
            if (isEarlyLeave) {
                return total + (earlyLeaveHoursById.get(leave._id.toString()) || 0);
            }

            return total + (leave.numberOfDays * WORKING_HOURS_PER_DAY);
        }, 0);
        const approvedLeaveDays = approvedLeaveHours / WORKING_HOURS_PER_DAY;

        // 1. Available & Per Type Stats
        let available = 0;
        let totalUsed = 0;
        let totalAllocatedSum = 0;

        const perType = activeLeaveTypes.map(lt => {
            const canonicalName = lt.name;
            const used = usedMap[canonicalName] || 0;
            const total = lt.defaultAmount;

            let currentBal = 0;
            if (user.leaveBalance && user.leaveBalance.has(canonicalName)) {
                currentBal = user.leaveBalance.get(canonicalName);
                if (lt.isPaid) {
                    available += currentBal;
                }
                totalUsed += used;
                totalAllocatedSum += (typeof total === 'number' ? total : (currentBal + used));
            } else if (lt.isPaid && typeof total === 'number') {
                currentBal = Math.max(0, total - used);
                available += currentBal;
                totalUsed += used;
                totalAllocatedSum += total;
            } else {
                currentBal = Infinity;
            }

            return {
                name: lt.name,
                code: lt.code,
                balance: currentBal,
                used,
                total: total,
                isPaid: lt.isPaid,
                accrualType: lt.accrualType,
                workingHoursPerDay: lt.workingHoursPerDay || 8
            };
        });

        // 3. Pending: Count of pending requests
        const pendingCount = await Leave.countDocuments({
            employeeId: userId,
            status: 'pending'
        });

        // 4. Total Allocated: Sum of all defaultAmount values for paid leave types
        const totalAllocated = totalAllocatedSum;

        res.json({
            status: 'success',
            data: {
                summary: {
                    available,
                    used: totalUsed,
                    approved: approvedLeaves.length,
                    approvedLeaveHours: Number(approvedLeaveHours.toFixed(2)),
                    approvedLeaveDays: Number(approvedLeaveDays.toFixed(2)),
                    pending: pendingCount,
                    totalAllocated
                },
                perType
            }
        });
    }),

    // Update User Leave Balance (Admin/HR)
    updateUserLeaveBalance: catchAsync(async (req, res) => {
        const { userId } = req.params;
        const { leaveBalance } = req.body;

        if (!leaveBalance || typeof leaveBalance !== 'object') {
            throw new BadRequestError('leaveBalance object is required in body');
        }

        const user = await User.findById(userId);
        if (!user) throw new NotFoundError('User not found');

        // Fetch active leave types to build a resolution map (Raw Name-based)
        const activeLeaveTypes = await LeaveType.find({ isActive: true });
        const typeResolutionMap = {};
        activeLeaveTypes.forEach(lt => {
            const canonicalName = lt.name;
            typeResolutionMap[lt.name.toLowerCase()] = canonicalName;
            typeResolutionMap[lt.code.toLowerCase()] = canonicalName;
        });

        const newBalances = leaveBalance.balances && Array.isArray(leaveBalance.balances)
            ? leaveBalance.balances.map(b => ({ type: b.name || b.code, value: b.currentBalance }))
            : Object.keys(leaveBalance).map(type => ({ type, value: leaveBalance[type] }));

        for (const item of newBalances) {
            if (typeof item.value === 'number') {
                const rawType = item.type.toLowerCase();
                const canonicalName = typeResolutionMap[rawType] || rawType;

                // Clear any existing keys that resolve to this same canonical name to prevent duplicates
                // e.g. if we are setting 'annual leave', remove 'al'
                if (user.leaveBalance) {
                    for (const existingKey of Array.from(user.leaveBalance.keys())) {
                        const existingCanonical = typeResolutionMap[existingKey.toLowerCase()] || existingKey.toLowerCase();
                        if (existingCanonical === canonicalName) {
                            user.leaveBalance.delete(existingKey);
                        }
                    }
                }

                user.leaveBalance.set(canonicalName, item.value);
                user.markModified('leaveBalance');
            }
        }

        await user.save();

        res.json({
            status: 'success',
            data: Object.fromEntries(user.leaveBalance),
        });
    }),

    // Helper function for calculating catch-up accrual between recordedDate and uploadDate
    // Supports dryRun: true for real-time dynamic preview without altering database
    calculateCatchUpAccrual: async ({
        employeeId,
        user,
        matchedLeaveType,
        recMoment,
        uploadMoment,
        dryRun = true,
        openingLedgerId = null,
        createdBy = null
    }) => {
        const hoursPerDay = matchedLeaveType.workingHoursPerDay || 8;
        const fromDateStr = recMoment.format('YYYY-MM-DD');
        const toDateStr = uploadMoment.format('YYYY-MM-DD');

        // If date is same or future, no accrual to calculate
        if (recMoment.isSame(uploadMoment) || recMoment.isAfter(uploadMoment)) {
            return {
                isSameDate: true,
                accruedDays: 0,
                accruedHours: 0,
                workingDays: 0,
                eligibleHours: 0,
                approvedUsed: 0,
                fromDate: fromDateStr,
                toDate: toDateStr
            };
        }

        let totalCatchUpAccrued = 0;
        let workingDays = 0;
        let totalEligibleHours = 0;
        let curr = recMoment.clone().add(1, 'day');

        while (curr.isSameOrBefore(uploadMoment)) {
            const dayStart = curr.clone().startOf('day').toDate();
            const dayEnd = curr.clone().endOf('day').toDate();
            const dateStr = curr.format('YYYY-MM-DD');

            // Check if an ACCRUAL ledger record already exists for this day (either catch-up or daily cron)
            const existingAccrual = await LeaveLedger.findOne({
                employee: employeeId,
                leaveType: matchedLeaveType._id,
                transactionType: 'ACCRUAL',
                effectiveDate: { $gte: dayStart, $lte: dayEnd }
            });

            if (existingAccrual) {
                totalCatchUpAccrued += existingAccrual.amount;
                workingDays += 1;
                totalEligibleHours += hoursPerDay;
            } else {
                // Check attendance for this date
                const attendance = await Attendance.findOne({
                    employeeId: user._id,
                    date: { $gte: dayStart, $lte: dayEnd }
                });

                let eligibleHours = 0;

                if (attendance) {
                    if (attendance.status === 'weekend' || attendance.status === 'holiday') {
                        eligibleHours = attendance.totalHours || 0;
                    } else if (attendance.status === 'absent') {
                        eligibleHours = 0;
                    } else if (attendance.totalHours > 0) {
                        eligibleHours = attendance.totalHours;
                    } else if (attendance.status === 'present') {
                        eligibleHours = hoursPerDay;
                    } else {
                        eligibleHours = attendance.totalHours || 0;
                    }
                } else {
                    // No attendance logged: check weekly off and holidays
                    const dayName = curr.format('dddd');
                    const weeklyOff = user.employment?.workingHours?.weeklyOff;
                    const isWeeklyOff = Array.isArray(weeklyOff) && weeklyOff.length > 0
                        ? weeklyOff.some(w => w.toLowerCase() === dayName.toLowerCase())
                        : (curr.day() === 0 || curr.day() === 6); // Sunday or Saturday

                    const isHoliday = await Holiday.exists({
                        date: { $gte: dayStart, $lte: dayEnd },
                        isActive: true
                    });

                    if (!isWeeklyOff && !isHoliday) {
                        eligibleHours = hoursPerDay;
                    } else {
                        eligibleHours = 0;
                    }
                }

                if (eligibleHours > 0) {
                    workingDays += 1;
                    totalEligibleHours += eligibleHours;
                }

                // Calculate earned leave according to leave policy
                let dayEarned = 0;
                if (matchedLeaveType.accrualType === 'hourly') {
                    const accrualRate = matchedLeaveType.hourlyAccrualRate || 0;
                    dayEarned = eligibleHours * accrualRate;
                } else {
                    // Fixed accrual
                    if (matchedLeaveType.hourlyAccrualRate > 0) {
                        dayEarned = eligibleHours * matchedLeaveType.hourlyAccrualRate;
                    } else if (matchedLeaveType.annualEntitlement > 0) {
                        dayEarned = eligibleHours > 0 ? (matchedLeaveType.annualEntitlement / 260) : 0;
                    } else if (matchedLeaveType.defaultAmount > 0) {
                        dayEarned = eligibleHours > 0 ? (matchedLeaveType.defaultAmount / 260) : 0;
                    }
                }

                const finalAmount = parseFloat(dayEarned.toFixed(4));
                if (finalAmount > 0) {
                    if (!dryRun && openingLedgerId) {
                        await LeaveLedger.create({
                            employee: employeeId,
                            leaveType: matchedLeaveType._id,
                            transactionType: 'ACCRUAL',
                            amount: finalAmount,
                            effectiveDate: dayStart,
                            description: `Daily accrual for ${eligibleHours}h on ${dateStr} (catch-up from opening balance)`,
                            referenceId: openingLedgerId,
                            createdBy
                        });
                    }
                    totalCatchUpAccrued += finalAmount;
                }
            }

            curr.add(1, 'day');
        }

        // Deduct approved leaves taken between recordedDate and uploadDate (if any)
        const approvedLeaves = await Leave.find({
            employeeId: user._id,
            status: 'approved',
            startDate: { $gte: recMoment.toDate(), $lte: uploadMoment.clone().endOf('day').toDate() }
        });

        let approvedUsed = 0;
        const canonicalName = matchedLeaveType.name;
        approvedLeaves.forEach(l => {
            const rawType = (l.leaveType || '').toLowerCase();
            if (
                rawType === (canonicalName || '').toLowerCase() ||
                rawType === (matchedLeaveType.code || '').toLowerCase()
            ) {
                approvedUsed += (l.numberOfDays || 0);
            }
        });

        const accruedDays = parseFloat(totalCatchUpAccrued.toFixed(4));
        const accruedHours = parseFloat((accruedDays * hoursPerDay).toFixed(2));

        return {
            isSameDate: false,
            accruedDays,
            accruedHours,
            workingDays,
            eligibleHours: totalEligibleHours,
            approvedUsed,
            fromDate: fromDateStr,
            toDate: toDateStr
        };
    },

    // Dynamic Preview of Eligible Leave Accrued Between Recorded Date and Today
    getOpeningBalancePreview: catchAsync(async (req, res) => {
        const { employeeId, recordedDate } = req.query;
        const leaveTypeId = req.query.leaveTypeId || req.query.leaveType;

        if (!employeeId || !leaveTypeId || !recordedDate) {
            throw new BadRequestError('employeeId, leaveTypeId, and recordedDate are required query parameters');
        }

        const user = await User.findById(employeeId);
        if (!user) throw new NotFoundError('User not found');

        const activeLeaveTypes = await LeaveType.find({ isActive: true });
        const lowerLeaveTypeId = leaveTypeId.toString().toLowerCase();

        let matchedLeaveType = activeLeaveTypes.find(lt =>
            lt._id.toString() === leaveTypeId ||
            (lt.code && lt.code.toLowerCase() === lowerLeaveTypeId) ||
            (lt.name && lt.name.toLowerCase() === lowerLeaveTypeId)
        );

        if (!matchedLeaveType) {
            throw new BadRequestError('Invalid leave type');
        }

        const userTz = user.employment?.timezone || 'Asia/Kolkata';
        const uploadMoment = moment.tz(new Date(), userTz).startOf('day');
        let recMoment = moment.tz(recordedDate, userTz).startOf('day');

        if (!recMoment.isValid()) {
            throw new BadRequestError('Invalid recordedDate');
        }

        const accrualResult = await leaveController.calculateCatchUpAccrual({
            employeeId,
            user,
            matchedLeaveType,
            recMoment,
            uploadMoment,
            dryRun: true
        });

        res.json({
            status: 'success',
            data: {
                employeeId,
                leaveType: matchedLeaveType.name,
                ...accrualResult
            }
        });
    }),

    // Add Opening Balance
    addOpeningBalance: catchAsync(async (req, res) => {
        const { employeeId, amount, description, recordedDate } = req.body;
        const leaveTypeId = req.body.leaveTypeId || req.body.leaveType;
        
        if (!leaveTypeId) {
            throw new BadRequestError('Leave type ID is required');
        }

        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount < 0) {
            throw new BadRequestError('Amount must be a valid positive number or 0');
        }
        
        const user = await User.findById(employeeId);
        if (!user) throw new NotFoundError('User not found');

        const activeLeaveTypes = await LeaveType.find({ isActive: true });
        const lowerLeaveTypeId = leaveTypeId.toString().toLowerCase();
        
        let matchedLeaveType = activeLeaveTypes.find(lt => 
            lt._id.toString() === leaveTypeId || 
            (lt.code && lt.code.toLowerCase() === lowerLeaveTypeId) || 
            (lt.name && lt.name.toLowerCase() === lowerLeaveTypeId)
        );

        if (!matchedLeaveType) {
            throw new BadRequestError('Invalid leave type');
        }

        const canonicalName = matchedLeaveType.name;
        const userTz = user.employment?.timezone || 'Asia/Kolkata';

        // Parse recorded date (when balance was recorded in previous HRM)
        // and upload date (current date)
        const uploadMoment = moment.tz(new Date(), userTz).startOf('day');
        let recMoment = recordedDate 
            ? moment.tz(recordedDate, userTz).startOf('day') 
            : uploadMoment.clone();

        if (!recMoment.isValid() || recMoment.isAfter(uploadMoment)) {
            recMoment = uploadMoment.clone();
        }

        // 1. Maintain a single OPENING_BALANCE ledger record to prevent duplicate baselines
        const existingOpenings = await LeaveLedger.find({
            employee: employeeId,
            leaveType: matchedLeaveType._id,
            transactionType: 'OPENING_BALANCE'
        }).sort({ createdAt: -1 });

        let openingLedger;
        if (existingOpenings.length > 0) {
            openingLedger = existingOpenings[0];
            openingLedger.amount = numericAmount;
            openingLedger.effectiveDate = recMoment.toDate();
            openingLedger.description = description || `Opening balance recorded as of ${recMoment.format('YYYY-MM-DD')}`;
            openingLedger.createdBy = req.user._id;
            await openingLedger.save();

            // Clean up any historical duplicate opening balance records if any existed
            if (existingOpenings.length > 1) {
                const dupIds = existingOpenings.slice(1).map(d => d._id);
                await LeaveLedger.deleteMany({ _id: { $in: dupIds } });
            }
        } else {
            openingLedger = await LeaveLedger.create({
                employee: employeeId,
                leaveType: matchedLeaveType._id,
                transactionType: 'OPENING_BALANCE',
                amount: numericAmount,
                effectiveDate: recMoment.toDate(),
                description: description || `Opening balance recorded as of ${recMoment.format('YYYY-MM-DD')}`,
                createdBy: req.user._id
            });
        }

        // 2. Clean up any previous catch-up ACCRUAL entries tied to this opening balance that fall on or before new recordedDate
        await LeaveLedger.deleteMany({
            employee: employeeId,
            leaveType: matchedLeaveType._id,
            transactionType: 'ACCRUAL',
            referenceId: openingLedger._id,
            effectiveDate: { $lte: recMoment.clone().endOf('day').toDate() }
        });

        // Also clean up any catch-up accruals that might fall after uploadMoment
        await LeaveLedger.deleteMany({
            employee: employeeId,
            leaveType: matchedLeaveType._id,
            transactionType: 'ACCRUAL',
            referenceId: openingLedger._id,
            effectiveDate: { $gt: uploadMoment.clone().endOf('day').toDate() }
        });

        // 3. Automatically calculate and add eligible leave accrued between recordedDate and uploadDate
        const accrualResult = await leaveController.calculateCatchUpAccrual({
            employeeId,
            user,
            matchedLeaveType,
            recMoment,
            uploadMoment,
            dryRun: false,
            openingLedgerId: openingLedger._id,
            createdBy: req.user._id
        });

        // 4. Accurate final balance: opening + accrued - approvedUsed
        const netBalance = Math.max(0, parseFloat((numericAmount + accrualResult.accruedDays - accrualResult.approvedUsed).toFixed(4)));

        // Update user leaveBalance map cleanly
        const freshUser = await User.findById(employeeId);
        if (freshUser) {
            if (!freshUser.leaveBalance) {
                freshUser.leaveBalance = new Map();
            }

            const typeResolutionMap = {};
            activeLeaveTypes.forEach(lt => {
                typeResolutionMap[lt.name.toLowerCase()] = lt.name;
                typeResolutionMap[lt.code.toLowerCase()] = lt.name;
            });

            for (const key of Array.from(freshUser.leaveBalance.keys())) {
                const resolved = typeResolutionMap[key.toLowerCase()] || key.toLowerCase();
                if (resolved === canonicalName) {
                    freshUser.leaveBalance.delete(key);
                }
            }

            freshUser.leaveBalance.set(canonicalName, netBalance);
            freshUser.markModified('leaveBalance');
            await freshUser.save();
        }

        res.json({
            status: 'success',
            data: {
                employeeId,
                leaveType: canonicalName,
                openingAmount: numericAmount,
                accruedAmount: accrualResult.accruedDays,
                approvedUsed: accrualResult.approvedUsed,
                newBalance: netBalance,
                recordedDate: recMoment.format('YYYY-MM-DD'),
                uploadDate: uploadMoment.format('YYYY-MM-DD')
            }
        });
    }),
};

module.exports = leaveController;


