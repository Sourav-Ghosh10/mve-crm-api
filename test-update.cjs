const mongoose = require('mongoose');
require('dotenv').config();
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Leave = require('./src/models/Leave');
  const User = require('./src/models/User');
  const leaveController = require('./src/controllers/leaveController');
  
  // Create a pending leave first
  const leave = new Leave({
    employeeId: '699c71ae46aaa6c422952e8a',
    leaveType: 'Hourly Leave',
    startDate: new Date('2026-08-31T10:30:00.000Z'),
    endDate: new Date('2026-08-31T10:30:00.000Z'),
    numberOfDays: 1,
    reason: 'test early leave',
    status: 'pending'
  });
  await leave.save();
  console.log('Created leave:', leave._id);
  
  // Mock req and res
  const req = {
    params: { id: leave._id.toString() },
    body: { status: 'approved', isDeductFromBalance: true },
    user: { _id: '699c71ae46aaa6c422952e8a', employment: { role: 'admin' } }
  };
  const res = {
    json: (data) => console.log('Response:', data),
    status: (code) => ({ json: (data) => console.log('Response', code, data) })
  };
  
  try {
    // We need to bypass the auth middleware, so we call the function directly
    // Since it's wrapped in catchAsync, we need to extract the inner function
    // But catchAsync returns a function(req, res, next)
    await leaveController.updateLeaveStatus(req, res, (err) => console.error('Next called with:', err));
  } catch (err) {
    console.error('Error:', err);
  }
  
  const updatedLeave = await Leave.findById(leave._id);
  console.log('Updated numberOfDays:', updatedLeave.numberOfDays);
  process.exit(0);
});
