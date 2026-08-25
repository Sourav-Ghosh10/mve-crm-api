const cron = require('node-cron');
const scheduleService = require('../services/scheduleService');

const initCronJobs = () => {
    // Weekly Roster Process (Every Sunday at 11:00 PM)
    cron.schedule('0 23 * * 0', async () => {
        console.log('[Cron] Starting weekly roster process (Generation + Cleanup)...');
        try {
            await scheduleService.processWeeklyRoster();
            console.log('[Cron] Weekly roster process completed successfully.');
        } catch (error) {
            console.error('[Cron] Error during weekly roster process:', error);
        }
    });

    // Monthly Leave Balance Reset (Midnight on the 1st of every month)
    cron.schedule('0 0 1 * *', async () => {
        console.log('[Cron] Starting monthly leave balance reset...');
        try {
            const leaveBalanceService = require('../services/leaveBalanceService');
            await leaveBalanceService.resetBalances('monthly');
        } catch (error) {
            console.error('[Cron] Error during monthly leave balance reset:', error);
        }
    });

    // Yearly Leave Balance Reset (Midnight on January 1st)
    cron.schedule('0 0 1 1 *', async () => {
        console.log('[Cron] Starting yearly leave balance reset...');
        try {
            const leaveBalanceService = require('../services/leaveBalanceService');
            await leaveBalanceService.resetBalances('yearly');
        } catch (error) {
            console.error('[Cron] Error during yearly leave balance reset:', error);
        }
    });

    
    // Daily Hourly Leave Accrual (Every night at 11:59 PM)
    cron.schedule('59 23 * * *', async () => {
        console.log('[Cron] Starting daily hourly leave accrual...');
        try {
            const leaveAccrualService = require('../services/leaveAccrualService');
            // Run for the current date
            const dateStr = new Date().toISOString().split('T')[0];
            await leaveAccrualService.processDailyAccrual(dateStr);
            console.log('[Cron] Daily hourly leave accrual completed.');
        } catch (error) {
            console.error('[Cron] Error during daily hourly leave accrual:', error);
        }
    });

    console.log('[Cron] Cron jobs initialized.');
};

module.exports = initCronJobs;
