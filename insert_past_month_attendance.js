const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const Attendance = require('./src/models/Attendance');
const User = require('./src/models/User');

async function seedPastMonthData() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to DB');

        const users = await User.find({ isActive: true });
        if (!users || users.length === 0) {
            console.log('No active users found!');
            process.exit(1);
        }
        
        console.log(`Found ${users.length} active users.`);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        let recordsAdded = 0;
        let recordsSkipped = 0;

        for (const user of users) {
            console.log(`Adding past month attendance for user: ${user.firstName} ${user.lastName}`);
            
            // Loop through each day in the past 30 days
            for (let d = new Date(thirtyDaysAgo); d <= today; d.setDate(d.getDate() + 1)) {
                const currentDate = new Date(d);
                
                // Check if attendance already exists for this day
                const existing = await Attendance.findOne({ employeeId: user._id, date: currentDate });
                if (existing) {
                    recordsSkipped++;
                    continue;
                }

                const dayOfWeek = currentDate.getDay();
                
                // Weekend (Saturday=6, Sunday=0)
                if (dayOfWeek === 0 || dayOfWeek === 6) {
                    const weekendAttendance = new Attendance({
                        employeeId: user._id,
                        date: currentDate,
                        status: 'weekend',
                    });
                    await weekendAttendance.save();
                    recordsAdded++;
                    continue;
                }

                // Weekday -> Randomize a bit to make it realistic
                const rand = Math.random();
                let checkInHour, checkInMin, checkOutHour, checkOutMin, isLate = false, isEarlyLeave = false;
                
                if (rand < 0.1) {
                    // 10% chance of being late
                    checkInHour = 9; checkInMin = 30;
                    checkOutHour = 18; checkOutMin = 0;
                    isLate = true;
                } else if (rand < 0.2) {
                    // 10% chance of leaving early
                    checkInHour = 8; checkInMin = 30;
                    checkOutHour = 16; checkOutMin = 30;
                    isEarlyLeave = true;
                } else {
                    // 80% chance of normal hours
                    checkInHour = 9; checkInMin = 0;
                    checkOutHour = 17; checkOutMin = 0;
                }

                const checkInTime = new Date(currentDate);
                checkInTime.setHours(checkInHour, checkInMin, 0, 0);
                
                const checkOutTime = new Date(currentDate);
                checkOutTime.setHours(checkOutHour, checkOutMin, 0, 0);
                
                const attendance = new Attendance({
                    employeeId: user._id,
                    date: currentDate,
                    checkIn: {
                        time: checkInTime,
                        ipAddress: '127.0.0.1',
                        deviceInfo: 'Past Month Dummy Script',
                    },
                    checkOut: {
                        time: checkOutTime,
                        ipAddress: '127.0.0.1',
                        deviceInfo: 'Past Month Dummy Script',
                    },
                    sessions: [{
                        checkIn: { time: checkInTime, ipAddress: '127.0.0.1', deviceInfo: 'Past Month Dummy Script' },
                        checkOut: { time: checkOutTime, ipAddress: '127.0.0.1', deviceInfo: 'Past Month Dummy Script' },
                        isLate,
                        isEarlyLeave
                    }],
                    status: 'present',
                    isLate,
                    isEarlyLeave
                });
                
                await attendance.save();
                recordsAdded++;
            }
        }
        
        console.log(`Successfully added ${recordsAdded} dummy attendance records (${recordsSkipped} skipped because they already existed).`);
        
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

seedPastMonthData();
