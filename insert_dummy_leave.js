const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const LeaveType = require('./src/models/LeaveType');
const LeaveLedger = require('./src/models/LeaveLedger');
const User = require('./src/models/User');

async function seedData() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to DB');

        let hourlyLeave = await LeaveType.findOne({ code: 'HOURLY' });

        const user = await User.findOne({ isActive: true, email: { $ne: 'admin@mvecrm.com' } });
        if (!user) {
            console.log('No active user found!');
            process.exit(1);
        }
        
        console.log('Adding balance to user: ' + user.firstName + ' ' + user.lastName);

        const ledgerEntry = new LeaveLedger({
            employee: user._id,
            leaveType: hourlyLeave._id,
            transactionType: 'OPENING_BALANCE',
            amount: 1.55,
            effectiveDate: new Date(),
            description: 'Dummy opening balance'
        });
        await ledgerEntry.save();
        
        if (!user.leaveBalance) {
            user.leaveBalance = new Map();
        }
        const currentBal = user.leaveBalance.get('hourly') || 0;
        user.leaveBalance.set('hourly', currentBal + 1.55);
        await user.save();
        
        console.log('Successfully added 1.55 Days of HOURLY leave balance to user.');
        
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

seedData();
