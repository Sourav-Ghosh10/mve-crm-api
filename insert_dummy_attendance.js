const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const Attendance = require('./src/models/Attendance');
const User = require('./src/models/User');

async function seedData() {
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

        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        for (const user of users) {
            console.log(`Adding dummy attendance for user: ${user.firstName} ${user.lastName}`);
            
            // Check if attendance already exists for today
            const existingToday = await Attendance.findOne({ employeeId: user._id, date: today });
            if (!existingToday) {
                const checkInTime = new Date(today);
                checkInTime.setHours(9, 0, 0, 0); // 9 AM
                
                const checkOutTime = new Date(today);
                checkOutTime.setHours(17, 0, 0, 0); // 5 PM
                
                const attendanceToday = new Attendance({
                    employeeId: user._id,
                    date: today,
                    checkIn: {
                        time: checkInTime,
                        ipAddress: '127.0.0.1',
                        deviceInfo: 'Dummy Script',
                    },
                    checkOut: {
                        time: checkOutTime,
                        ipAddress: '127.0.0.1',
                        deviceInfo: 'Dummy Script',
                    },
                    sessions: [{
                        checkIn: { time: checkInTime, ipAddress: '127.0.0.1', deviceInfo: 'Dummy Script' },
                        checkOut: { time: checkOutTime, ipAddress: '127.0.0.1', deviceInfo: 'Dummy Script' }
                    }],
                    status: 'present',
                });
                await attendanceToday.save();
                console.log(`  Added attendance for today (${today.toISOString().split('T')[0]})`);
            } else {
                console.log(`  Attendance already exists for today.`);
            }

            // Check if attendance already exists for yesterday
            const existingYesterday = await Attendance.findOne({ employeeId: user._id, date: yesterday });
            if (!existingYesterday) {
                const checkInTimeYest = new Date(yesterday);
                checkInTimeYest.setHours(9, 30, 0, 0); // 9:30 AM (Late)
                
                const checkOutTimeYest = new Date(yesterday);
                checkOutTimeYest.setHours(18, 0, 0, 0); // 6 PM (Overtime)
                
                const attendanceYesterday = new Attendance({
                    employeeId: user._id,
                    date: yesterday,
                    checkIn: {
                        time: checkInTimeYest,
                        ipAddress: '127.0.0.1',
                        deviceInfo: 'Dummy Script',
                    },
                    checkOut: {
                        time: checkOutTimeYest,
                        ipAddress: '127.0.0.1',
                        deviceInfo: 'Dummy Script',
                    },
                    sessions: [{
                        checkIn: { time: checkInTimeYest, ipAddress: '127.0.0.1', deviceInfo: 'Dummy Script' },
                        checkOut: { time: checkOutTimeYest, ipAddress: '127.0.0.1', deviceInfo: 'Dummy Script' },
                        isLate: true
                    }],
                    status: 'present',
                    isLate: true
                });
                await attendanceYesterday.save();
                console.log(`  Added attendance for yesterday (${yesterday.toISOString().split('T')[0]})`);
            } else {
                console.log(`  Attendance already exists for yesterday.`);
            }
        }
        
        console.log('Successfully added dummy attendance records.');
        
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

seedData();
