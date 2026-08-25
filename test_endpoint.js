const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();
const User = require('./src/models/User');
const LeaveType = require('./src/models/LeaveType');

async function test() {
    await mongoose.connect(process.env.MONGODB_URI);
    const userId = '699c71b846aaa6c422952e8c';
    const user = await User.findById(userId).select('leaveBalance personalInfo employment.department');
    if (!user) { console.log('no user'); process.exit(0); }
    
    const activeLeaveTypes = await LeaveType.find({
        isActive: true,
        $or: [
            { applicableDepartments: 'all' },
            { applicableDepartments: user.employment?.department }
        ]
    });
    
    const typeResolutionMap = {};
    activeLeaveTypes.forEach(lt => {
        const canonicalName = lt.name;
        typeResolutionMap[lt.name.toLowerCase()] = canonicalName;
        typeResolutionMap[lt.code.toLowerCase()] = canonicalName;
    });

    const balances = activeLeaveTypes.map(lt => {
        const canonicalName = lt.name;
        let currentBalance = 0;
        
        // Match with user.leaveBalance using lowercase code/name
        const leaveMap = user.leaveBalance || new Map();
        currentBalance = leaveMap.get(lt.code.toLowerCase()) || leaveMap.get(lt.name.toLowerCase()) || leaveMap.get(lt._id.toString()) || 0;
        
        return {
            name: lt.name,
            code: lt.code,
            currentBalance: currentBalance,
            accrualType: lt.accrualType,
            workingHoursPerDay: lt.workingHoursPerDay
        };
    });
    
    console.log(JSON.stringify(balances, null, 2));
    process.exit(0);
}
test();
