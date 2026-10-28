const express = require('express');
const salaryConfigController = require('../controllers/salaryConfigController');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { 
  createSalaryConfigSchema, 
  updateSalaryConfigSchema,
  createSalaryRevisionSchema,
} = require('../validators/payrollValidator');
const { idParamSchema } = require('../validators/commonValidator');

const router = express.Router();

router.use(authenticate);

/**
 * @swagger
 * tags:
 *   name: Salary Config
 *   description: Employee salary configuration management
 */

/**
 * @swagger
 * /api/payroll/salary-configs:
 *   get:
 *     summary: Get all salary configurations
 *     tags: [Salary Config]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: employeeId
 *         schema:
 *           type: string
 *       - in: query
 *         name: isActive
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: List of configurations
 *   post:
 *     summary: Create a new salary configuration
 *     tags: [Salary Config]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - employeeId
 *               - monthlyCTC
 *               - effectiveFrom
 *             properties:
 *               employeeId:
 *                 type: string
 *               monthlyCTC:
 *                 type: number
 *               effectiveFrom:
 *                 type: string
 *                 format: date
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     masterId:
 *                       type: string
 *                     overrideValue:
 *                       type: number
 *     responses:
 *       201:
 *         description: Config created
 */
router.get('/', salaryConfigController.getConfigs);
router.post('/', validate(createSalaryConfigSchema), salaryConfigController.createConfig);

// Specific routes before /:id
router.get('/revisions/:employeeId', salaryConfigController.getRevisions);
router.post('/revisions', validate(createSalaryRevisionSchema), salaryConfigController.createRevision);
router.delete('/revisions/:id', validate(idParamSchema, 'params'), salaryConfigController.cancelRevision);
router.get('/employee/:employeeId', salaryConfigController.getLatestConfigByEmployee);

/**
 * @swagger
 * /api/payroll/salary-configs/{id}:
 *   get:
 *     summary: Get configuration by ID
 *     tags: [Salary Config]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Config details
 *   put:
 *     summary: Update configuration
 *     tags: [Salary Config]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Config updated
 *   delete:
 *     summary: Delete configuration
 *     tags: [Salary Config]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Config deleted
 */
router.get('/:id', validate(idParamSchema, 'params'), salaryConfigController.getConfigById);
router.put('/:id', validate(idParamSchema, 'params'), validate(updateSalaryConfigSchema), salaryConfigController.updateConfig);
router.delete('/:id', validate(idParamSchema, 'params'), salaryConfigController.deleteConfig);

module.exports = router;
