const mongoose = require('mongoose');
const SalaryConfig = require('./src/models/SalaryConfig');
const salaryConfigService = require('./src/services/salaryConfigService');

mongoose.connect('mongodb://127.0.0.1:27017/mve-crm').catch(e => mongoose.connect('mongodb://127.0.0.1:27017/pulse-ops')).then(async () => {
  const config = await SalaryConfig.findOne({});
  if (!config) {
    console.log("No config found");
    process.exit(0);
  }
  console.log("Found config:", config._id);
  try {
    const updated = await salaryConfigService.updateConfig(config._id, {
      monthlyCTC: 55000,
      effectiveFrom: new Date(),
      isActive: true,
      items: config.items.map(i => ({ masterId: i.masterId.toString(), overrideValue: 0, isActive: true }))
    });
    console.log("Update success!");
  } catch (err) {
    console.error("Update failed:", err.message, err.stack);
  }
  process.exit(0);
});
