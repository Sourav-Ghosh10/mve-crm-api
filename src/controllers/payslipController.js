const payslipService = require('../services/payslipService');
const { generatePayslipPDF } = require('../utils/pdfGenerator');

const payslipController = {
  getPayslips: async (req, res, next) => {
    try {
      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 10;
      const filters = {
        employeeId: req.query.employeeId,
        month: req.query.month ? parseInt(req.query.month, 10) : undefined,
        year: req.query.year ? parseInt(req.query.year, 10) : undefined,
        status: req.query.status,
      };

      const roleName = req.user?.employment?.role;
      const isAdmin = (req.user && req.user.isAdmin === true) || 
                      (roleName === 'Super Admin' || roleName === 'admin');

      if (!isAdmin) {
        filters.employeeId = req.user._id;
        filters.status = 'FINALIZED';
      }

      const result = await payslipService.getPayslips({ page, limit, filters });

      res.status(200).json({
        success: true,
        data: result.payslips,
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

  getPayslipById: async (req, res, next) => {
    try {
      const payslip = await payslipService.getPayslipById(req.params.id);
      res.status(200).json({
        success: true,
        data: payslip,
      });
    } catch (error) {
      next(error);
    }
  },

  generatePayslip: async (req, res, next) => {
    try {
      const payslip = await payslipService.generatePayslip({
        ...req.body,
        requestedBy: req.user._id // Assuming auth middleware adds user to req
      });
      res.status(201).json({
        success: true,
        message: 'Payslip generated successfully',
        data: payslip,
      });
    } catch (error) {
      next(error);
    }
  },

  updateStatus: async (req, res, next) => {
    try {
      const { status } = req.body;
      const payslip = await payslipService.updatePayslipStatus(
        req.params.id, 
        status, 
        req.user._id
      );
      res.status(200).json({
        success: true,
        message: `Payslip status updated to ${status}`,
        data: payslip,
      });
    } catch (error) {
      next(error);
    }
  },

  deletePayslip: async (req, res, next) => {
    try {
      await payslipService.deletePayslip(req.params.id);
      res.status(200).json({
        success: true,
        message: 'Payslip deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  },

  sendPayslipEmail: async (req, res, next) => {
    try {
      await payslipService.sendPayslipEmail(req.params.id);
      res.status(200).json({
        success: true,
        message: 'Payslip sent to email successfully',
      });
    } catch (error) {
      next(error);
    }
  },

  downloadPayslipPDF: async (req, res, next) => {
    try {
      const payslip = await payslipService.getPayslipById(req.params.id);
      const pdfBuffer = await generatePayslipPDF(payslip, payslip.employeeId);
      
      const moment = require('moment');
      const monthName = moment().month(payslip.month - 1).format('MMMM');
      const firstName = payslip.employeeId?.personalInfo?.firstName || 'Employee';
      const lastName = payslip.employeeId?.personalInfo?.lastName || '';
      const fullName = `${firstName}_${lastName}`.replace(/\s+/g, '_');
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition', 
        `attachment; filename=Payslip_${fullName}_${monthName}_${payslip.year}.pdf`
      );
      res.send(pdfBuffer);
    } catch (error) {
      next(error);
    }
  },

  publishPayslips: async (req, res, next) => {
    try {
      const { month, year } = req.body;
      const finalizedBy = req.user._id;

      if (!month || !year) {
        return res.status(400).json({
          success: false,
          message: 'Month and year are required'
        });
      }

      // Update all DRAFT payslips for this period to FINALIZED
      const Payslip = require('../models/Payslip');
      const result = await Payslip.updateMany(
        { 
          month: parseInt(month, 10), 
          year: parseInt(year, 10), 
          status: 'DRAFT' 
        },
        { 
          $set: { 
            status: 'FINALIZED',
            finalizedBy,
            finalizedAt: new Date()
          } 
        }
      );

      res.status(200).json({
        success: true,
        message: `Successfully generated and published ${result.modifiedCount} payslips for ${month}/${year}.`,
        data: {
          modifiedCount: result.modifiedCount
        }
      });
    } catch (error) {
      next(error);
    }
  },

  exportPayslipsExcel: async (req, res, next) => {
    try {
      const ExcelJS = require('exceljs');
      const filters = {
        month: req.query.month ? parseInt(req.query.month, 10) : undefined,
        year: req.query.year ? parseInt(req.query.year, 10) : undefined,
        status: req.query.status,
      };

      const roleName = req.user?.employment?.role;
      const isAdmin = (req.user && req.user.isAdmin === true) || 
                      (roleName === 'Super Admin' || roleName === 'admin');

      if (!isAdmin) {
        return res.status(403).json({ success: false, message: 'Not authorized to export all payslips' });
      }

      const result = await payslipService.getPayslips({ page: 1, limit: 10000, filters });

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Monthly Salary');

      worksheet.columns = [
        { header: 'Employee ID', key: 'empId', width: 15 },
        { header: 'Employee Name', key: 'empName', width: 25 },
        { header: 'Designation', key: 'designation', width: 25 },
        { header: 'Month', key: 'month', width: 10 },
        { header: 'Year', key: 'year', width: 10 },
        { header: 'Gross Earnings', key: 'gross', width: 15 },
        { header: 'Total Deductions', key: 'deductions', width: 15 },
        { header: 'Net Pay', key: 'net', width: 15 },
        { header: 'Status', key: 'status', width: 15 },
      ];

      result.payslips.forEach(p => {
        const user = p.employeeId;
        const empId = user?.employeeId || user?.employment?.employeeId || 'N/A';
        const name = `${user?.personalInfo?.firstName || ''} ${user?.personalInfo?.lastName || ''}`.trim();
        const designation = user?.employment?.designation?.name || user?.employment?.designation || 'N/A';

        worksheet.addRow({
          empId,
          empName: name,
          designation,
          month: require('moment')().month(p.month - 1).format('MMM').toUpperCase(),
          year: p.year,
          gross: p.grossEarnings,
          deductions: p.totalDeductions,
          net: p.netPay,
          status: p.status
        });
      });

      // Style header row
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
      };

      const monthName = filters.month ? require('moment')().month(filters.month - 1).format('MMM') : 'All';
      const yearName = filters.year || 'All';
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=Monthly_Salary_${monthName}_${yearName}.xlsx`);

      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      next(error);
    }
  },
};

module.exports = payslipController;
