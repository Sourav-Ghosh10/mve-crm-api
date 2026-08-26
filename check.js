const mongoose = require('mongoose');
require('dotenv').config();

async function check() {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mve-crm');
    const LeaveType = require('./src/models/LeaveType');
    
    const leaveTypes = await LeaveType.find({});
    let bad = 0;
    leaveTypes.forEach(lt => {
        if (!lt.name || !lt.code) {
            console.log('Bad LeaveType:', lt);
            bad++;
        }
    });
    console.log(`Found ${bad} bad leave types out of ${leaveTypes.length}`);
    process.exit(0);
}

check();
