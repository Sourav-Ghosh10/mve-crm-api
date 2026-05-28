const PDFDocument = require('pdfkit');
const moment = require('moment');
const SystemSettings = require('../models/SystemSettings');

function numberToWords(num) {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  
  if (num === 0) return "Zero";
  
  const convert = (n) => {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? " " + ones[n % 10] : "");
    if (n < 1000) return ones[Math.floor(n / 100)] + " Hundred" + (n % 100 !== 0 ? " and " + convert(n % 100) : "");
    if (n < 100000) return convert(Math.floor(n / 1000)) + " Thousand" + (n % 1000 !== 0 ? " " + convert(n % 1000) : "");
    if (n < 10000000) return convert(Math.floor(n / 100000)) + " Lakh" + (n % 100000 !== 0 ? " " + convert(n % 100000) : "");
    return String(n);
  };
  
  return convert(num);
}

/**
 * Generates a professional PDF payslip
 * @param {Object} payslip - Payslip data
 * @param {Object} user - User data
 * @returns {Promise<Buffer>} - PDF as buffer
 */
const generatePayslipPDF = async (payslip, user) => {
  try {
    const signatureSetting = await SystemSettings.findOne({ key: 'payslip_signature' });
    const signatureBase64 = signatureSetting ? signatureSetting.value : null;

    const currencyNameSetting = await SystemSettings.findOne({ key: 'currency_name' });
    const currencyName = currencyNameSetting ? currencyNameSetting.value : 'Rupees';

    const currencySymbolSetting = await SystemSettings.findOne({ key: 'currency_symbol' });
    const currencySymbol = currencySymbolSetting ? currencySymbolSetting.value : '';

    return new Promise((resolve, reject) => {
      try {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const chunks = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const monthName = moment().month(payslip.month - 1).format('MMM');
      const year = payslip.year;

      // Header Area
      doc.font('Helvetica-Bold').fontSize(11).text('My Virtual Employee', { align: 'center' });
      doc.font('Helvetica-Bold').fontSize(9).text('Mani Casadona, Plot No. IIF/04, Newtown, Kolkata – 700156., Kolkata, West Bengal - 700156', { align: 'center' });
      doc.font('Helvetica-Bold').fontSize(10).text(`Wage Slip for the month of ${monthName}/${year}`, { align: 'center' });

      doc.moveDown(1.5);

      const startY = doc.y;
      
      // Employee Details Section
      doc.font('Helvetica').fontSize(9);
      
      const empId = user.employeeId || user.employment?.employeeId || '';
      const esiNo = user.esiNumber || user.employment?.esiNumber || '';
      const doj = user.employment?.dateOfJoining ? moment(user.employment.dateOfJoining).format('DD/MM/YYYY') : (user.dateOfJoining ? moment(user.dateOfJoining).format('DD/MM/YYYY') : '');
      const uan = user.uanNumber || user.employment?.uanNumber || '';
      
      const empName = `${user.personalInfo?.firstName || ''} ${user.personalInfo?.lastName || ''}`;
      const payDays = payslip.daysWorked.toString();
      const designation = user.employment?.designation?.name || user.employment?.designation || '';
      const lopDays = payslip.lopDays.toString();

      // Left column
      doc.text('EMP ID', 40, startY);
      doc.text(empId, 120, startY);
      
      doc.text('Designation', 40, startY + 15);
      doc.text(designation, 120, startY + 15);
      
      doc.text('DOJ', 40, startY + 30);
      doc.text(doj, 120, startY + 30);
      
      // Right column
      doc.text('Employee Name:', 280, startY);
      doc.text(empName, 370, startY);
      
      doc.text('Pay Days', 280, startY + 15);
      doc.text(payDays, 370, startY + 15);
      
      doc.text('LOP Days', 280, startY + 30);
      doc.text(lopDays, 370, startY + 30);

      doc.moveDown(1); // Adjusted spacing since it's 3 rows instead of 4
      
      // Main Salary Table
      const tableTop = doc.y;
      const rowHeight = 15;
      
      // Table Header Background
      doc.rect(40, tableTop, 515, rowHeight).stroke();
      
      const amtHeader = currencySymbol ? `Amount (${currencySymbol})` : 'Amount';

      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('Earnings', 40, tableTop + 3, { width: 155, align: 'center' });
      doc.text(amtHeader, 195, tableTop + 3, { width: 100, align: 'center' });
      doc.text('Deductions', 295, tableTop + 3, { width: 160, align: 'center' });
      doc.text(amtHeader, 455, tableTop + 3, { width: 100, align: 'center' });

      // Separate arrays for earnings and deductions
      const earnings = payslip.items.filter(i => i.type === 'ALLOWANCE');
      const deductions = payslip.items.filter(i => i.type === 'DEDUCTION');
      
      // We need to fill at least to a certain height for aesthetics, let's say 12 rows or maxRows
      const minRows = 12;
      const maxRows = Math.max(earnings.length, deductions.length, minRows);
      let currentY = tableTop + rowHeight;

      doc.font('Helvetica').fontSize(9);
      
      // Draw outer boundaries for content area
      const contentHeight = maxRows * rowHeight;
      doc.rect(40, currentY, 515, contentHeight).stroke();
      
      // Draw vertical lines for the whole table (header + content)
      doc.moveTo(195, tableTop).lineTo(195, currentY + contentHeight).stroke();
      doc.moveTo(295, tableTop).lineTo(295, currentY + contentHeight).stroke();
      doc.moveTo(455, tableTop).lineTo(455, currentY + contentHeight).stroke();

      for (let i = 0; i < maxRows; i++) {
        const textY = currentY + 3;
        
        if (earnings[i]) {
          doc.text(earnings[i].name, 45, textY, { width: 145 });
          doc.text(earnings[i].amount.toFixed(2), 195, textY, { width: 95, align: 'right' });
        }
        
        if (deductions[i]) {
          doc.text(deductions[i].name, 300, textY, { width: 150 });
          doc.text(deductions[i].amount.toFixed(2), 455, textY, { width: 95, align: 'right' });
        }
        
        currentY += rowHeight;
      }

      // Total Row
      doc.rect(40, currentY, 515, rowHeight).stroke();
      
      doc.font('Helvetica-Bold');
      doc.text('Total', 45, currentY + 3);
      doc.text(payslip.grossEarnings.toFixed(2), 195, currentY + 3, { width: 95, align: 'right' });

      doc.text('Total', 300, currentY + 3);
      doc.text(payslip.totalDeductions.toFixed(2), 455, currentY + 3, { width: 95, align: 'right' });

      currentY += rowHeight;

      // Net Pay & In Words Row
      const footerHeight = 60;
      doc.rect(40, currentY, 515, footerHeight).stroke();

      doc.font('Helvetica-Bold');
      doc.text('Net Pay', 45, currentY + 5);
      doc.text(payslip.netPay.toFixed(2), 120, currentY + 5);

      doc.text('In Words', 45, currentY + 20);
      doc.text(`${currencyName} ${numberToWords(payslip.netPay)} Only`, 120, currentY + 20);

      // Signature
      if (signatureBase64) {
        try {
          const base64Data = signatureBase64.replace(/^data:image\/\w+;base64,/, "");
          const imgBuffer = Buffer.from(base64Data, 'base64');
          doc.image(imgBuffer, 440, currentY + 10, { fit: [100, 30], align: 'right' });
        } catch (err) {
          console.error("Error embedding signature:", err);
        }
      }

      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('Signature', 40, currentY + 45, { width: 500, align: 'right' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
  } catch (error) {
    return Promise.reject(error);
  }
};

module.exports = { generatePayslipPDF };
