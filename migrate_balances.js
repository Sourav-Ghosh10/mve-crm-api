const mongoose = require('mongoose');
require('dotenv').config();

async function migrateLeaveBalances() {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mve-crm');
    const User = require('./src/models/User');
    const LeaveType = require('./src/models/LeaveType');

    const activeLeaveTypes = await LeaveType.find({});
    const typeResolutionMap = {};
    activeLeaveTypes.forEach(lt => {
        typeResolutionMap[lt.name.toLowerCase()] = lt.name;
        typeResolutionMap[lt.code.toLowerCase()] = lt.name;
    });

    const users = await User.find({});
    let updatedCount = 0;

    for (const user of users) {
        if (!user.leaveBalance || user.leaveBalance.size === 0) continue;

        let modified = false;
        const normalized = {};

        // Iterate through Mongoose Map
        for (const [key, value] of user.leaveBalance.entries()) {
            const canonicalName = typeResolutionMap[key.toLowerCase()] || key;
            normalized[canonicalName] = value;
            if (key !== canonicalName) {
                modified = true;
            }
        }

        if (modified) {
            user.set('leaveBalance', normalized);
            await user.save({ validateBeforeSave: false }); // Skip complex validation rules
            updatedCount++;
        }
    }

    console.log(`Migrated leaveBalance keys for ${updatedCount} users.`);
    process.exit(0);
}

migrateLeaveBalances().catch(console.error);
