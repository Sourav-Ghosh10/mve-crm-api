const SalaryConfig = require('../models/SalaryConfig');
const { NotFoundError } = require('../utils/errors');
const logger = require('../utils/logger');

const SalaryRevision = require('../models/SalaryRevision');

const salaryConfigService = {
  getConfigs: async ({ page, limit, filters }) => {
    const query = {};
    if (filters.isActive !== undefined) query.isActive = filters.isActive;
    if (filters.employeeId) query.employeeId = filters.employeeId;

    const [configs, total] = await Promise.all([
      SalaryConfig.find(query)
        .populate('employeeId', 'personalInfo employment employeeId')
        .populate('items.masterId')
        .sort({ effectiveFrom: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SalaryConfig.countDocuments(query),
    ]);

    return { configs, total };
  },

  getConfigById: async (id) => {
    const config = await SalaryConfig.findById(id)
      .populate('employeeId', 'personalInfo employment employeeId')
      .populate('items.masterId')
      .lean();
    if (!config) {
      throw new NotFoundError('Salary configuration not found');
    }
    return config;
  },

  getLatestConfigByEmployee: async (employeeId) => {
    const now = new Date();
    // Prefer the active configuration currently in effect
    let config = await SalaryConfig.findOne({
      employeeId,
      isActive: true,
      effectiveFrom: { $lte: now },
    })
      .populate('items.masterId')
      .sort({ effectiveFrom: -1 })
      .lean();

    // Fallback to latest config if none effective yet
    if (!config) {
      config = await SalaryConfig.findOne({ employeeId, isActive: true })
        .populate('items.masterId')
        .sort({ effectiveFrom: -1 })
        .lean();
    }
    return config;
  },

  createConfig: async (data, userId = null) => {
    const now = new Date();
    const effDate = new Date(data.effectiveFrom);

    // If there is an existing config with the EXACT same effectiveFrom date, deactivate that duplicate
    await SalaryConfig.updateMany(
      {
        employeeId: data.employeeId,
        effectiveFrom: effDate,
        isActive: true,
      },
      { isActive: false }
    );

    const config = await SalaryConfig.create({
      ...data,
      effectiveFrom: effDate,
      revisionReason: data.revisionReason || 'Initial Salary Setup',
      isActive: data.isActive !== undefined ? data.isActive : true,
    });

    // Record initial or new SalaryRevision
    const isFuture = effDate > now;
    const existingActive = await SalaryConfig.findOne({
      employeeId: data.employeeId,
      isActive: true,
      _id: { $ne: config._id },
      effectiveFrom: { $lte: now },
    }).sort({ effectiveFrom: -1 }).lean();

    const oldCTC = existingActive ? Number(existingActive.monthlyCTC || 0) : 0;

    await SalaryRevision.create({
      employeeId: data.employeeId,
      salaryConfigId: config._id,
      oldCTC,
      revisedCTC: Number(data.monthlyCTC || 0),
      effectiveDate: effDate,
      revisionReason: data.revisionReason || (oldCTC > 0 ? 'Salary Revision' : 'Initial Salary Setup'),
      status: isFuture ? 'SCHEDULED' : 'CURRENT',
      items: data.items || [],
      revisedBy: userId,
      isActive: true,
    });

    logger.info(`Salary configuration created for employee: ${data.employeeId}`);
    return config;
  },

  updateConfig: async (id, data, userId = null) => {
    const existingConfig = await SalaryConfig.findById(id);
    if (!existingConfig) {
      throw new NotFoundError('Salary configuration not found');
    }

    const newCTC = data.monthlyCTC !== undefined ? Number(data.monthlyCTC) : existingConfig.monthlyCTC;
    const newEffDate = data.effectiveFrom !== undefined ? new Date(data.effectiveFrom) : existingConfig.effectiveFrom;
    const oldCTC = Number(existingConfig.monthlyCTC || 0);

    const isCTCChanged = newCTC !== oldCTC;
    const isDateChanged = newEffDate.getTime() !== new Date(existingConfig.effectiveFrom).getTime();
    const isExplicitRevision = Boolean(data.revisionReason && data.revisionReason.trim());

    // If salary amount or effective date is changed, or explicit revision is submitted:
    // Store as a new revision without overwriting previous records!
    if (isCTCChanged || isDateChanged || isExplicitRevision) {
      const now = new Date();
      const isFuture = newEffDate > now;

      // Ensure historical initial revision exists for the existing config
      const priorRevision = await SalaryRevision.findOne({
        employeeId: existingConfig.employeeId,
        salaryConfigId: existingConfig._id,
      });

      if (!priorRevision) {
        await SalaryRevision.create({
          employeeId: existingConfig.employeeId,
          salaryConfigId: existingConfig._id,
          oldCTC: 0,
          revisedCTC: oldCTC,
          effectiveDate: existingConfig.effectiveFrom,
          revisionReason: existingConfig.revisionReason || 'Initial Configuration',
          status: new Date(existingConfig.effectiveFrom) > now ? 'SCHEDULED' : 'CURRENT',
          items: existingConfig.items || [],
          isActive: true,
        });
      }

      // Create new SalaryConfig record (DO NOT overwrite existingConfig!)
      const newConfig = await SalaryConfig.create({
        employeeId: existingConfig.employeeId,
        monthlyCTC: newCTC,
        effectiveFrom: newEffDate,
        isActive: data.isActive !== undefined ? data.isActive : true,
        revisionReason: data.revisionReason || 'Salary Revision',
        items: data.items !== undefined ? data.items : existingConfig.items,
      });

      // If new revision is effective immediately, mark previous CURRENT revisions as PREVIOUS
      if (!isFuture) {
        await SalaryRevision.updateMany(
          { employeeId: existingConfig.employeeId, status: 'CURRENT' },
          { status: 'PREVIOUS' }
        );
      }

      // Record the SalaryRevision
      await SalaryRevision.create({
        employeeId: existingConfig.employeeId,
        salaryConfigId: newConfig._id,
        oldCTC,
        revisedCTC: newCTC,
        effectiveDate: newEffDate,
        revisionReason: data.revisionReason || 'Salary Revision',
        status: isFuture ? 'SCHEDULED' : 'CURRENT',
        items: data.items !== undefined ? data.items : existingConfig.items,
        revisedBy: userId,
        isActive: true,
      });

      logger.info(
        `Salary revision recorded for employee: ${existingConfig.employeeId}. Preserved prior record ${id}. New config: ${newConfig._id}`
      );
      return newConfig;
    }

    // Otherwise, it is an in-place minor modification (e.g. updating an override value on same config)
    const config = await SalaryConfig.findByIdAndUpdate(
      id,
      { ...data, updatedAt: new Date() },
      { new: true, runValidators: true }
    );

    logger.info(`Salary configuration in-place updated: ${id}`);
    return config;
  },

  deleteConfig: async (id) => {
    const config = await SalaryConfig.findByIdAndDelete(id);
    if (!config) {
      throw new NotFoundError('Salary configuration not found');
    }
    await SalaryRevision.updateMany({ salaryConfigId: id }, { isActive: false });
    logger.info(`Salary configuration deleted: ${id}`);
    return config;
  },
};

module.exports = salaryConfigService;
