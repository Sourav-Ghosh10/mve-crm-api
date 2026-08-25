const mongoose = require('mongoose');

const leaveLedgerSchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Employee reference is required'],
        },
        leaveType: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'LeaveType',
            required: [true, 'Leave type reference is required'],
        },
        transactionType: {
            type: String,
            enum: [
                'OPENING_BALANCE',
                'ACCRUAL',
                'LEAVE_DEDUCTION',
                'MANUAL_ADDITION',
                'MANUAL_DEDUCTION',
                'REVERSAL',
                'ADJUSTMENT',
            ],
            required: [true, 'Transaction type is required'],
        },
        amount: {
            type: Number,
            required: [true, 'Amount is required'],
        },
        effectiveDate: {
            type: Date,
            required: [true, 'Effective date is required'],
        },
        description: {
            type: String,
            trim: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        referenceId: {
            type: mongoose.Schema.Types.ObjectId,
            // Could reference Attendance, Leave, etc. based on transactionType
        }
    },
    {
        timestamps: true,
    }
);

// Prevent duplicate accrual for the same date, employee, and leave type
// Since effectiveDate includes time, it might be better to store a specific date string or rely on application logic.
// We will rely on application logic for now, or add a 'dateString' field if needed.
leaveLedgerSchema.index({ employee: 1, leaveType: 1 });

const LeaveLedger = mongoose.model('LeaveLedger', leaveLedgerSchema);

module.exports = LeaveLedger;
