const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');

// All notification routes require authentication
router.use(authenticate);

// Token registration
router.post('/register', notificationController.registerToken);
router.post('/unregister', notificationController.unregisterToken);

// Notification operations
router.get('/', notificationController.getNotifications);
router.put('/mark-all-read', notificationController.markAllRead);
router.put('/:id/mark-read', notificationController.markAsRead);

module.exports = router;
