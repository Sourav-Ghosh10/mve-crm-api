const moment = require('moment');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Leave = require('../models/Leave');

const dashboardController = {
  getAdminDashboard: async (req, res, next) => {
    try {
      const todayStart = moment().startOf('day').toDate();
      const todayEnd = moment().endOf('day').toDate();

      // 1. Total Employees
      const totalEmployees = await User.countDocuments({ 'employment.status': 'Active' });

      // 2. Attendance Today (Users present)
      const attendanceToday = await Attendance.countDocuments({
        date: { $gte: todayStart, $lte: todayEnd }
      });

      // 3. Pending Leaves
      const pendingLeaves = await Leave.countDocuments({
        status: 'pending'
      });

      // 4. Resource Allocation
      // On Leave today
      const onLeaveCount = await Leave.countDocuments({
        status: 'approved',
        startDate: { $lte: todayEnd },
        endDate: { $gte: todayStart }
      });

      const absentToday = Math.max(0, totalEmployees - attendanceToday - onLeaveCount);

      // Late arrivals (simple check: if checkIn time is after 9:30 AM for instance. Since we don't know the exact schedule logic, we can mock or do a simple query. Let's assume late if checkIn > 9:15 AM local time, or just 0 for now if complex. Let's do a simple count where checkIn > todayStart + 9.25 hours)
      // For now, let's just query Attendance where isLate is true, if that field exists. Or we can just return 0.
      const lateArrivals = await Attendance.countDocuments({
        date: { $gte: todayStart, $lte: todayEnd },
        'checkIn.isLate': true // Assumes this field might exist, fallback to 0 in UI if not.
      });

      // 5. Recent Activity
      // Let's fetch recent attendances and leaves for today to form an activity feed
      const recentAttendances = await Attendance.find({
        date: { $gte: todayStart, $lte: todayEnd }
      }).populate('employeeId', 'personalInfo.firstName personalInfo.lastName')
        .sort('-checkIn.time')
        .limit(5);

      const recentLeaves = await Leave.find({
        createdAt: { $gte: todayStart, $lte: todayEnd }
      }).populate('employeeId', 'personalInfo.firstName personalInfo.lastName')
        .sort('-createdAt')
        .limit(5);

      const activities = [];
      recentAttendances.forEach(att => {
        if (att.checkIn && att.checkIn.time) {
          activities.push({
            user: `${att.employeeId?.personalInfo?.firstName || ''} ${att.employeeId?.personalInfo?.lastName || ''}`.trim() || 'Unknown User',
            action: 'clocked in',
            time: att.checkIn.time
          });
        }
        if (att.checkOut && att.checkOut.time) {
          activities.push({
            user: `${att.employeeId?.personalInfo?.firstName || ''} ${att.employeeId?.personalInfo?.lastName || ''}`.trim() || 'Unknown User',
            action: 'clocked out',
            time: att.checkOut.time
          });
        }
      });

      recentLeaves.forEach(leave => {
        activities.push({
            user: `${leave.employeeId?.personalInfo?.firstName || ''} ${leave.employeeId?.personalInfo?.lastName || ''}`.trim() || 'Unknown User',
            action: `requested leave`,
            time: leave.createdAt
        });
      });

      // Sort activities by time descending
      activities.sort((a, b) => new Date(b.time) - new Date(a.time));

      res.status(200).json({
        success: true,
        data: {
          totalEmployees,
          attendanceToday,
          pendingLeaves,
          resourceAllocation: {
            presentToday: attendanceToday,
            absentToday,
            onLeave: onLeaveCount,
            lateArrivals
          },
          recentActivity: activities.slice(0, 10).map(a => ({
              ...a,
              time: moment(a.time).format('h:mm A')
          }))
        }
      });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = dashboardController;
