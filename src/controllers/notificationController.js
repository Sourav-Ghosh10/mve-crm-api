const Notification = require('../models/Notification');
const catchAsync = require('../utils/catchAsync');

const notificationController = {
  // Register push token
  registerToken: catchAsync(async (req, res) => {
    // Basic implementation: if you have a FCM tokens array in User, you could add it.
    // For now, return success.
    res.status(200).json({ success: true, message: 'Token registered successfully' });
  }),

  // Unregister push token
  unregisterToken: catchAsync(async (req, res) => {
    // Basic implementation
    res.status(200).json({ success: true, message: 'Token unregistered successfully' });
  }),

  // Get user notifications
  getNotifications: catchAsync(async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 20;
    
    const notifications = await Notification.find({ recipientId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(limit);
      
    // Count unread
    const unreadCount = await Notification.countDocuments({ 
        recipientId: req.user._id, 
        isRead: false 
    });

    res.status(200).json({
      success: true,
      data: notifications,
      unreadCount
    });
  }),

  // Mark specific notification as read
  markAsRead: catchAsync(async (req, res) => {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipientId: req.user._id },
      { isRead: true, readAt: new Date() },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.status(200).json({ success: true, data: notification });
  }),

  // Mark all notifications as read for user
  markAllRead: catchAsync(async (req, res) => {
    await Notification.updateMany(
      { recipientId: req.user._id, isRead: false },
      { isRead: true, readAt: new Date() }
    );

    res.status(200).json({ success: true, message: 'All notifications marked as read' });
  })
};

module.exports = notificationController;
