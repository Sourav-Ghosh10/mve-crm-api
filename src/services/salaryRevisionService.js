const SalaryRevision = require('../models/SalaryRevision');
const SalaryConfig = require('../models/SalaryConfig');
const { NotFoundError, BadRequestError } = require('../utils/errors');
const logger = require('../utils/logger');

const salaryRevisionService = {
  getRevisionsByEmployee: async (employeeId) => {
    let revisions = await SalaryRevision.find({ employeeId, isActive: true })
      .populate('revisedBy', 'personalInfo email employeeId')
      .populate('items.masterId')
      .sort({ effectiveDate: -1, createdAt: -1 })
      .lean();

    // If no revisions exist yet, backfill from existing SalaryConfigs for seamless history
    if (revisions.length === 0) {
      const existingConfigs = await SalaryConfig.find({ employeeId, isActive: true })
        .sort({ effectiveFrom: 1, createdAt: 1 })
        .lean();

      if (existingConfigs.length > 0) {
        let prevCTC = 0;
        const now = new Date();

        for (let i = 0; i < existingConfigs.length; i++) {
          const cfg = existingConfigs[i];
          const isFuture = new Date(cfg.effectiveFrom) > now;
          await SalaryRevision.create({
            employeeId,
            salaryConfigId: cfg._id,
            oldCTC: prevCTC,
            revisedCTC: cfg.monthlyCTC || 0,
            effectiveDate: cfg.effectiveFrom,
            revisionReason: cfg.revisionReason || (i === 0 ? 'Initial Configuration' : 'Salary Revision'),
            status: isFuture ? 'SCHEDULED' : 'CURRENT',
            items: cfg.items || [],
            isActive: true,
          });
          prevCTC = cfg.monthlyCTC || 0;
        }

        revisions = await SalaryRevision.find({ employeeId, isActive: true })
          .populate('revisedBy', 'personalInfo email employeeId')
          .populate('items.masterId')
          .sort({ effectiveDate: -1, createdAt: -1 })
          .lean();
      }
    }

    // Dynamically calculate and synchronize current vs scheduled vs previous status
    const now = new Date();
    let currentFound = false;

    // Process from newest effectiveDate to oldest
    const updatedRevisions = [];
    for (const rev of revisions) {
      const effDate = new Date(rev.effectiveDate);
      let calculatedStatus = 'PREVIOUS';

      if (effDate > now) {
        calculatedStatus = 'SCHEDULED';
      } else if (!currentFound) {
        calculatedStatus = 'CURRENT';
        currentFound = true;
      } else {
        calculatedStatus = 'PREVIOUS';
      }

      if (rev.status !== calculatedStatus) {
        await SalaryRevision.findByIdAndUpdate(rev._id, { status: calculatedStatus });
        rev.status = calculatedStatus;
      }
      updatedRevisions.push(rev);
    }

    return updatedRevisions;
  },

  createRevision: async (data, userId = null) => {
    const { employeeId, revisedCTC, effectiveDate, revisionReason, items = [] } = data;
    const now = new Date();
    const effDate = new Date(effectiveDate);

    // Get current active salary configuration for oldCTC reference
    const currentConfig = await SalaryConfig.findOne({
      employeeId,
      isActive: true,
      effectiveFrom: { $lte: now },
    })
      .sort({ effectiveFrom: -1 })
      .lean();

    const fallbackConfig = currentConfig || (await SalaryConfig.findOne({ employeeId, isActive: true }).sort({ effectiveFrom: -1 }).lean());
    const oldCTC = fallbackConfig ? Number(fallbackConfig.monthlyCTC || 0) : 0;

    // Create new SalaryConfig without overwriting historical ones
    const newConfig = await SalaryConfig.create({
      employeeId,
      monthlyCTC: revisedCTC,
      effectiveFrom: effDate,
      revisionReason: revisionReason || 'Salary Revision',
      isActive: true,
      items,
    });

    const isScheduled = effDate > now;
    const initialStatus = isScheduled ? 'SCHEDULED' : 'CURRENT';

    // If new revision takes immediate effect, mark prior CURRENT revision as PREVIOUS
    if (!isScheduled) {
      await SalaryRevision.updateMany(
        { employeeId, status: 'CURRENT' },
        { status: 'PREVIOUS' }
      );
    }

    const revision = await SalaryRevision.create({
      employeeId,
      salaryConfigId: newConfig._id,
      oldCTC,
      revisedCTC,
      effectiveDate: effDate,
      revisionReason: revisionReason || 'Salary Revision',
      status: initialStatus,
      items,
      revisedBy: userId,
      isActive: true,
    });

    logger.info(`Salary revision recorded for employee: ${employeeId}. Old CTC: ${oldCTC}, New CTC: ${revisedCTC}, Status: ${initialStatus}`);

    return SalaryRevision.findById(revision._id)
      .populate('revisedBy', 'personalInfo email employeeId')
      .populate('items.masterId')
      .lean();
  },

  cancelRevision: async (revisionId) => {
    const revision = await SalaryRevision.findById(revisionId);
    if (!revision) {
      throw new NotFoundError('Salary revision not found');
    }

    const now = new Date();
    if (new Date(revision.effectiveDate) <= now && revision.status !== 'SCHEDULED') {
      throw new BadRequestError('Cannot cancel an already effective or historical salary revision');
    }

    // Soft delete or remove revision
    revision.isActive = false;
    await revision.save();

    // Deactivate or delete associated future SalaryConfig
    if (revision.salaryConfigId) {
      await SalaryConfig.findByIdAndUpdate(revision.salaryConfigId, { isActive: false });
    }

    logger.info(`Scheduled salary revision ${revisionId} cancelled successfully`);
    return { success: true, message: 'Scheduled salary revision cancelled successfully' };
  },
};

module.exports = salaryRevisionService;
