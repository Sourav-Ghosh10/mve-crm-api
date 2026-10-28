const mongoose = require('mongoose');

const salaryConfigItemSchema = new mongoose.Schema({
  masterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AllowanceDeductionMaster',
    required: true,
  },
  overrideValue: { type: Number, default: null },
  isActive: { type: Boolean, default: true },
});

const salaryRevisionSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    salaryConfigId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SalaryConfig',
    },
    oldCTC: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    revisedCTC: {
      type: Number,
      required: true,
      min: 0,
    },
    effectiveDate: {
      type: Date,
      required: true,
      index: true,
    },
    revisionReason: {
      type: String,
      required: true,
      trim: true,
      default: 'Salary Revision',
    },
    status: {
      type: String,
      enum: ['PREVIOUS', 'CURRENT', 'SCHEDULED'],
      default: 'SCHEDULED',
      index: true,
    },
    items: [salaryConfigItemSchema],
    revisedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

salaryRevisionSchema.index({ employeeId: 1, effectiveDate: -1 });

module.exports = mongoose.model('SalaryRevision', salaryRevisionSchema);
