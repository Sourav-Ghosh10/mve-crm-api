const salaryConfigService = require('../services/salaryConfigService');
const salaryRevisionService = require('../services/salaryRevisionService');

const salaryConfigController = {
  getConfigs: async (req, res, next) => {
    try {
      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 10;
      const filters = {
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
        employeeId: req.query.employeeId,
      };

      const result = await salaryConfigService.getConfigs({ page, limit, filters });

      res.status(200).json({
        success: true,
        data: result.configs,
        pagination: {
          total: result.total,
          page,
          limit,
          pages: Math.ceil(result.total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  },

  getConfigById: async (req, res, next) => {
    try {
      const config = await salaryConfigService.getConfigById(req.params.id);
      res.status(200).json({
        success: true,
        data: config,
      });
    } catch (error) {
      next(error);
    }
  },

  getLatestConfigByEmployee: async (req, res, next) => {
    try {
      const config = await salaryConfigService.getLatestConfigByEmployee(req.params.employeeId);
      res.status(200).json({
        success: true,
        data: config,
      });
    } catch (error) {
      next(error);
    }
  },

  createConfig: async (req, res, next) => {
    try {
      const config = await salaryConfigService.createConfig(req.body, req.user?._id);
      res.status(201).json({
        success: true,
        message: 'Salary configuration created successfully',
        data: config,
      });
    } catch (error) {
      next(error);
    }
  },

  updateConfig: async (req, res, next) => {
    try {
      const config = await salaryConfigService.updateConfig(req.params.id, req.body, req.user?._id);
      res.status(200).json({
        success: true,
        message: 'Salary configuration updated successfully',
        data: config,
      });
    } catch (error) {
      next(error);
    }
  },

  deleteConfig: async (req, res, next) => {
    try {
      await salaryConfigService.deleteConfig(req.params.id);
      res.status(200).json({
        success: true,
        message: 'Salary configuration deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  },

  // Salary Revision Endpoints
  getRevisions: async (req, res, next) => {
    try {
      const revisions = await salaryRevisionService.getRevisionsByEmployee(req.params.employeeId);
      res.status(200).json({
        success: true,
        data: revisions,
      });
    } catch (error) {
      next(error);
    }
  },

  createRevision: async (req, res, next) => {
    try {
      const revision = await salaryRevisionService.createRevision(req.body, req.user?._id);
      res.status(201).json({
        success: true,
        message: 'Salary revision created successfully',
        data: revision,
      });
    } catch (error) {
      next(error);
    }
  },

  cancelRevision: async (req, res, next) => {
    try {
      const result = await salaryRevisionService.cancelRevision(req.params.id);
      res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  },
};

module.exports = salaryConfigController;
