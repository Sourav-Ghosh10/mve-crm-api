const mongoose = require('mongoose');
require('dotenv').config();
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const LeaveType = require('./src/models/LeaveType');
  const Leave = require('./src/models/Leave');
  const User = require('./src/models/User');
  const targetUserId = '699c71ae46aaa6c422952e8a';
  const user = await User.findById(targetUserId);
  const activeLeaveTypes = await LeaveType.find({isActive: true});
  const startOfYear = new Date(new Date().getFullYear(), 0, 1);
  const endOfYear = new Date(new Date().getFullYear(), 11, 31, 23, 59, 59, 999);
  
  const approvedLeaves = await Leave.find({employeeId: targetUserId, status: 'approved', startDate: { $gte: startOfYear, $lte: endOfYear }});
  const typeResolutionMap = {};
  activeLeaveTypes.forEach(lt => {
      typeResolutionMap[lt.name.toLowerCase()] = lt.name;
      typeResolutionMap[lt.code.toLowerCase()] = lt.name;
  });
  const usedMap = {};
  approvedLeaves.forEach(l => {
      const rawType = (l.leaveType || '').toLowerCase();
      const canonicalCode = typeResolutionMap[rawType] || rawType;
      usedMap[canonicalCode] = (usedMap[canonicalCode] || 0) + l.numberOfDays;
  });
  
  const balances = activeLeaveTypes.map(lt => {
      const canonicalName = lt.name;
      const used = usedMap[canonicalName] || 0;
      let totalAllocated = lt.defaultAmount ?? '';
      let currentBalance = 0;
      if (user.leaveBalance && user.leaveBalance.has(canonicalName)) {
          totalAllocated = user.leaveBalance.get(canonicalName);
          currentBalance = Math.max(0, totalAllocated - used);
      } else if (lt.isPaid && typeof totalAllocated === 'number') {
          currentBalance = Math.max(0, totalAllocated - used);
      } else {
          currentBalance = '';
      }
      return { name: lt.name, used, totalAllocated, currentBalance };
  });
  console.log(balances);
  process.exit(0);
});
