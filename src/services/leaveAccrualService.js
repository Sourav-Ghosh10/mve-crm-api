const User = require('../models/User');
const LeaveType = require('../models/LeaveType');
const LeaveLedger = require('../models/LeaveLedger');
const Attendance = require('../models/Attendance');
const logger = require('../utils/logger');
const mongoose = require('mongoose');
const moment = require('moment-timezone'); // Assuming moment is available

const leaveAccrualService = {
    /**
     * Process hourly leave accrual for the given date.
     * @param {Date|string} dateStr The date to process (e.g., 'YYYY-MM-DD')
     */
    processDailyAccrual: async (dateStr) => {
        try {
            logger.info(`Starting daily hourly leave accrual for date: ${dateStr}`);
            
            // Get all hourly accrual leave types
            const hourlyLeaveTypes = await LeaveType.find({
                isActive: true,
                accrualType: 'hourly'
            });

            if (hourlyLeaveTypes.length === 0) {
                logger.info('No active hourly leave types found.');
                return;
            }

            // Find attendances for the given date that are 'Present' or have eligible working hours
            // Using a simple date range for the query
            const startDate = moment(dateStr).startOf('day').toDate();
            const endDate = moment(dateStr).endOf('day').toDate();

            const attendances = await Attendance.find({
                date: {
                    $gte: startDate,
                    $lte: endDate
                }
            }).populate('employeeId');

            for (const attendance of attendances) {
                const user = attendance.employeeId;
                if (!user || !user.isActive) continue;

                // Calculate eligible hours
                const eligibleHours = attendance.totalHours || 0;
                
                // If there are no worked hours, skip
                if (eligibleHours <= 0) continue;

                for (const leaveType of hourlyLeaveTypes) {
                    // Check if leave type applies to user department
                    if (!leaveType.applicableDepartments.includes('all') &&
                        !leaveType.applicableDepartments.includes(user.employment?.department)) {
                        continue;
                    }

                    // Check if already accrued for this specific day to prevent duplicate entries
                    // Since effectiveDate is the exact timestamp, we should look for an ACCRUAL entry created for this specific date range
                    const existingAccrual = await LeaveLedger.findOne({
                        employee: user._id,
                        leaveType: leaveType._id,
                        transactionType: 'ACCRUAL',
                        effectiveDate: {
                            $gte: startDate,
                            $lte: endDate
                        }
                    });

                    if (existingAccrual) {
                        logger.info(`Accrual already processed for user ${user._id} on ${dateStr} for leave ${leaveType.code}`);
                        continue;
                    }

                    const accrualRate = leaveType.hourlyAccrualRate || 0;
                    if (accrualRate <= 0) continue;

                    // Calculate earned leave
                    const earnedLeave = eligibleHours * accrualRate;
                    // Format to 4 decimal places for precision handling
                    const finalAmount = parseFloat(earnedLeave.toFixed(4));
                    
                    if (finalAmount > 0) {
                        const session = await mongoose.startSession();
                        session.startTransaction();
                        try {
                            // Create Ledger Entry
                            const ledgerEntry = new LeaveLedger({
                                employee: user._id,
                                leaveType: leaveType._id,
                                transactionType: 'ACCRUAL',
                                amount: finalAmount,
                                effectiveDate: startDate, // Assign it to the start of the date being processed
                                description: `Accrual for ${eligibleHours} hours worked on ${dateStr}`,
                                referenceId: attendance._id
                            });
                            await ledgerEntry.save({ session });

                            // Update User Balance
                            const leaveTypeKey = leaveType.code.toLowerCase();
                            const currentBalance = user.leaveBalance.get(leaveTypeKey) || 0;
                            user.leaveBalance.set(leaveTypeKey, currentBalance + finalAmount);
                            await user.save({ session });

                            await session.commitTransaction();
                            logger.info(`Accrued ${finalAmount} for user ${user._id} on ${dateStr} for leave ${leaveType.code}`);
                        } catch (err) {
                            await session.abortTransaction();
                            logger.error(`Failed to process accrual for user ${user._id} on ${dateStr}:`, err);
                        } finally {
                            session.endSession();
                        }
                    }
                }
            }
            logger.info(`Completed daily hourly leave accrual for date: ${dateStr}`);
        } catch (error) {
            logger.error('Error during hourly leave accrual:', error);
        }
    }
};

module.exports = leaveAccrualService;

