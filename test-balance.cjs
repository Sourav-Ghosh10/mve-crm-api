const mongoose = require('mongoose');
require('dotenv').config({path: '../mve-crm-api/.env'});
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const LeaveType = require('../mve-crm-api/src/models/LeaveType');
  const Leave = require('../mve-crm-api/src/models/Leave');
  const targetUserId = '699c71ae46aaa6c422952e8a';
  
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
  console.log('UsedMap:', usedMap);
  process.exit(0);
});
