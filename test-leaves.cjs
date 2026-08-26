const mongoose = require('mongoose');
require('dotenv').config();
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Leave = require('./src/models/Leave');
  const leaves = await Leave.find({status: 'approved', _id: {$in: ['699c71b846aaa6c422952e8c', '699c71ae46aaa6c422952e8a']}});
  console.log(JSON.stringify(leaves, null, 2));
  process.exit(0);
});
