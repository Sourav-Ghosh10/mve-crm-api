const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authenticate, authorize } = require('../middleware/auth');
const { USER_ROLES } = require('../config/constants');

// Apply protection to all routes
router.use(authenticate);

// Admin stats route
router.get('/admin-stats', authorize(USER_ROLES.ADMIN, USER_ROLES.MANAGER, USER_ROLES.SUPER_ADMIN), dashboardController.getAdminDashboard);

module.exports = router;
